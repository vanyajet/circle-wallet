/**
 * Входящие на treasury и их классификация (design-doc §4).
 *
 * На treasury приходят: (а) «вторая нога» нашего sweep и (б) сторонние поступления (house float).
 * Ошибка в классификации стоит денег: sweep, принятый за house funding, удвоит CUSTODY treasury;
 * house funding, принятый за sweep, занизит ликвидность. При сомнении ошибаемся в безопасную сторону —
 * НЕ проводим (ждём или UNCLASSIFIED), потому что учтённая ликвидность ниже реальной — это безопасно.
 *
 * Порядок сопоставления: тот же circle id, что у sweep (у внутреннего перевода ноги могут делить id) →
 * тот же txHash → адрес источника (наш deposit-адрес = точно sweep, ждём; чужой = house funding).
 */
import { parseUnits } from '@circle-wallet/shared';
import { sql } from 'kysely';
import type { CircleTransaction } from '../circle/gateway';
import type { Token, TreasuryInbound, Wallet } from '../db/schema';
import { enqueueJob, wakeWithdrawalsAwaitingLiquidity } from '../jobs/queue';
import { isFailureState, isSuccessState, shouldApplyState } from './circle-state';
import type { AppContext } from './context';
import { custody, house, postLedgerTransaction } from './ledger';
import { applySweepTransaction } from './sweeps';

/** Сколько ждать появления sweep для поступления с нашего deposit-адреса, прежде чем пометить UNCLASSIFIED. */
const OWN_SOURCE_TIMEOUT_MS = 30 * 60_000;
/** Сколько ждать, если адрес источника неизвестен и есть подходящие sweep'ы в сети. */
const UNKNOWN_SOURCE_TIMEOUT_MS = 10 * 60_000;
/** Минимальная выдержка перед признанием house funding при неизвестном источнике. */
const UNKNOWN_SOURCE_MIN_AGE_MS = 60_000;

export type ClassifyOutcome = { type: 'done'; result: string } | { type: 'wait'; delayMs: number; reason: string };

export async function applyTreasuryInboundTransaction(
  ctx: AppContext,
  wallet: Wallet,
  token: Token,
  tx: CircleTransaction,
): Promise<string> {
  if (!tx.amount) return 'IGNORED:no_amount';
  const amount = parseUnits(tx.amount, token.decimals);
  if (amount <= 0n) return 'IGNORED:zero_amount';

  return ctx.db.transaction().execute(async (trx) => {
    const inserted = await trx
      .insertInto('app.treasury_inbounds')
      .values({
        wallet_id: wallet.id,
        token: token.symbol,
        amount: amount.toString(),
        circle_transaction_id: tx.id,
        circle_state: tx.state,
        tx_hash: tx.txHash,
        source_address: tx.sourceAddress,
      })
      .onConflict((oc) => oc.column('circle_transaction_id').doNothing())
      .returning('id')
      .executeTakeFirst();
    const row = await trx
      .selectFrom('app.treasury_inbounds')
      .selectAll()
      .where('circle_transaction_id', '=', tx.id)
      .forUpdate()
      .executeTakeFirstOrThrow();

    if (!inserted && !shouldApplyState(row.circle_state, tx.state)) return 'NOOP:stale_state';
    await trx
      .updateTable('app.treasury_inbounds')
      .set({
        circle_state: tx.state,
        tx_hash: tx.txHash ?? row.tx_hash,
        source_address: tx.sourceAddress ?? row.source_address,
        ...(isFailureState(tx.state) && row.classification === 'PENDING'
          ? { classification: 'FAILED' as const, classified_at: new Date() }
          : {}),
      })
      .where('id', '=', row.id)
      .execute();

    if (isSuccessState(tx.state) && row.classification === 'PENDING') {
      await enqueueJob(trx, 'treasury-inbound.classify', { treasuryInboundId: row.id }, { dedupeKey: `treasury-inbound:${row.id}` });
    }
    return `APPLIED:${tx.state}`;
  });
}

/** Задача treasury-inbound.classify. */
export async function classifyTreasuryInbound(ctx: AppContext, treasuryInboundId: string): Promise<ClassifyOutcome> {
  let inbound = await ctx.db
    .selectFrom('app.treasury_inbounds')
    .selectAll()
    .where('id', '=', treasuryInboundId)
    .executeTakeFirst();
  if (!inbound) return { type: 'done', result: 'IGNORED:not_found' };
  if (inbound.classification !== 'PENDING') return { type: 'done', result: `NOOP:${inbound.classification}` };

  // 1-2. Совпадение с известным sweep по id или txHash.
  let sweepId = await matchSweep(ctx, inbound);
  let enrichmentFailed = false;

  // Не нашли — обогащаем данные из REST (вебхук мог прийти без txHash/sourceAddress/refId) и обновляем sweep'ы в сети.
  if (!sweepId) {
    const enriched = await enrichInbound(ctx, inbound);
    inbound = enriched.inbound;
    enrichmentFailed = enriched.failed;
    sweepId = await matchSweepByRefId(ctx, enriched.refId);
    if (!sweepId) {
      await refreshSubmittedSweeps(ctx, inbound.token);
      sweepId = await matchSweep(ctx, inbound);
    }
  }

  if (sweepId) {
    return finalize(ctx, inbound.id, 'SWEEP', sweepId);
  }

  const age = Date.now() - inbound.created_at.getTime();
  if (inbound.source_address) {
    const fromOurDepositWallet = await ctx.db
      .selectFrom('app.wallets')
      .select('id')
      .where('kind', '=', 'DEPOSIT')
      .where('address', '=', inbound.source_address)
      .executeTakeFirst();
    if (fromOurDepositWallet) {
      // С нашего deposit-адреса может прийти только sweep — в house такое не проводим никогда.
      if (age < OWN_SOURCE_TIMEOUT_MS) return { type: 'wait', delayMs: 30_000, reason: 'own deposit source, sweep not matched yet' };
      return finalize(ctx, inbound.id, 'UNCLASSIFIED', null);
    }
    return finalize(ctx, inbound.id, 'HOUSE_FUNDING', null);
  }

  // Источник неизвестен, потому что Circle сейчас недоступен — решать вслепую нельзя, ждём.
  if (enrichmentFailed && age < UNKNOWN_SOURCE_TIMEOUT_MS) {
    return { type: 'wait', delayMs: 30_000, reason: 'cannot fetch inbound details from Circle' };
  }

  // Источник неизвестен: если есть sweep на ту же сумму, ещё не сопоставленный ни с одним входящим
  // (в сети или уже завершённый, но без txHash), — ждём сопоставления; иначе после выдержки считаем house funding.
  let candidates = unmatchedSweeps(ctx, inbound.token).where('s.amount', '=', inbound.amount);
  // Если хэш входящего известен, sweep с другим известным хэшем — точно не он (совпадающий нашёлся бы выше).
  if (inbound.tx_hash) candidates = candidates.where('s.tx_hash', 'is', null);
  const candidate = await candidates.executeTakeFirst();
  if (candidate && age < UNKNOWN_SOURCE_TIMEOUT_MS) {
    return { type: 'wait', delayMs: 30_000, reason: 'unknown source, matching sweep in flight' };
  }
  if (candidate) return finalize(ctx, inbound.id, 'UNCLASSIFIED', null);
  if (age < UNKNOWN_SOURCE_MIN_AGE_MS) return { type: 'wait', delayMs: UNKNOWN_SOURCE_MIN_AGE_MS - age + 1_000, reason: 'unknown source' };
  return finalize(ctx, inbound.id, 'HOUSE_FUNDING', null);
}

async function matchSweep(ctx: AppContext, inbound: TreasuryInbound): Promise<string | null> {
  const byId = await ctx.db
    .selectFrom('app.sweeps')
    .select('id')
    .where('circle_transaction_id', '=', inbound.circle_transaction_id)
    .executeTakeFirst();
  if (byId) return byId.id;
  if (!inbound.tx_hash) return null;
  const byHash = await ctx.db
    .selectFrom('app.sweeps')
    .select('id')
    .where(sql<string>`lower(tx_hash)`, '=', inbound.tx_hash.toLowerCase())
    .executeTakeFirst();
  return byHash?.id ?? null;
}

async function enrichInbound(
  ctx: AppContext,
  inbound: TreasuryInbound,
): Promise<{ inbound: TreasuryInbound; refId: string | null; failed: boolean }> {
  try {
    const tx = await ctx.circle.getTransaction(inbound.circle_transaction_id, 'INBOUND');
    let row = inbound;
    if ((!inbound.tx_hash && tx.txHash) || (!inbound.source_address && tx.sourceAddress)) {
      row = await ctx.db
        .updateTable('app.treasury_inbounds')
        .set({ tx_hash: inbound.tx_hash ?? tx.txHash, source_address: inbound.source_address ?? tx.sourceAddress })
        .where('id', '=', inbound.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    return { inbound: row, refId: tx.refId, failed: false };
  } catch (error) {
    ctx.logger.warn({ err: error, treasuryInboundId: inbound.id }, 'failed to enrich treasury inbound');
    return { inbound, refId: null, failed: true };
  }
}

/** Если входящая нога несёт наш refId (sweep:<id>) — это точное сопоставление. */
async function matchSweepByRefId(ctx: AppContext, refId: string | null): Promise<string | null> {
  const id = refId?.startsWith('sweep:') ? refId.slice('sweep:'.length) : null;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const sweep = await ctx.db.selectFrom('app.sweeps').select('id').where('id', '=', id).executeTakeFirst();
  return sweep?.id ?? null;
}

/** Sweep'ы, чья входящая нога на treasury ещё не найдена: активные или завершённые за последние сутки. */
function unmatchedSweeps(ctx: AppContext, token: string) {
  return ctx.db
    .selectFrom('app.sweeps as s')
    .select(['s.id', 's.status', 's.tx_hash', 's.circle_transaction_id'])
    .where('s.token', '=', token)
    .where((eb) =>
      eb.or([
        eb('s.status', 'in', ['PENDING', 'SUBMITTED']),
        eb.and([eb('s.status', '=', 'COMPLETED'), eb('s.completed_at', '>', sql<Date>`now() - interval '1 day'`)]),
      ]),
    )
    .where(({ not, exists, selectFrom }) =>
      not(exists(selectFrom('app.treasury_inbounds as ti').select('ti.id').whereRef('ti.sweep_id', '=', 's.id'))),
    );
}

/**
 * У SCA txHash появляется только на CONFIRMED, а вебхук может прийти без него —
 * подтягиваем свежее состояние несопоставленных sweep'ов без хэша, чтобы сравнить по txHash.
 */
async function refreshSubmittedSweeps(ctx: AppContext, token: string): Promise<void> {
  const sweeps = await unmatchedSweeps(ctx, token).where('s.tx_hash', 'is', null).limit(20).execute();
  for (const sweep of sweeps) {
    if (!sweep.circle_transaction_id) continue;
    try {
      const tx = await ctx.circle.getTransaction(sweep.circle_transaction_id, 'OUTBOUND');
      if (sweep.status === 'COMPLETED') {
        // Завершённый sweep state machine уже не трогает — дописываем только хэш.
        if (tx.txHash) await ctx.db.updateTable('app.sweeps').set({ tx_hash: tx.txHash }).where('id', '=', sweep.id).execute();
      } else {
        await applySweepTransaction(ctx, tx, 'reconcile');
      }
    } catch (error) {
      ctx.logger.warn({ err: error, sweepId: sweep.id }, 'failed to refresh sweep');
    }
  }
}

async function finalize(
  ctx: AppContext,
  inboundId: string,
  classification: 'SWEEP' | 'HOUSE_FUNDING' | 'UNCLASSIFIED',
  sweepId: string | null,
): Promise<ClassifyOutcome> {
  return ctx.db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('app.treasury_inbounds')
      .selectAll()
      .where('id', '=', inboundId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (row.classification !== 'PENDING') return { type: 'done' as const, result: `NOOP:${row.classification}` };
    await trx
      .updateTable('app.treasury_inbounds')
      .set({ classification, sweep_id: sweepId, classified_at: new Date() })
      .where('id', '=', row.id)
      .execute();

    if (classification === 'HOUSE_FUNDING') {
      const amount = BigInt(row.amount);
      await postLedgerTransaction(trx, {
        kind: 'HOUSE_FUNDING',
        referenceId: row.id,
        description: `House float ${row.circle_transaction_id}`,
        lines: [
          { account: custody(row.wallet_id, row.token), direction: 'DEBIT', amount },
          { account: house(row.token), direction: 'CREDIT', amount },
        ],
      });
      await wakeWithdrawalsAwaitingLiquidity(trx);
    }
    if (classification === 'UNCLASSIFIED') {
      ctx.logger.error({ treasuryInboundId: row.id }, 'treasury inbound could not be classified — manual review required');
    }
    return { type: 'done' as const, result: classification };
  });
}
