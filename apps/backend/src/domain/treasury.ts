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
import { enqueueJob, wakeJobs } from '../jobs/queue';
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

  // Не нашли — обогащаем данные из REST (вебхук мог прийти без txHash/sourceAddress) и обновляем sweep'ы в сети.
  if (!sweepId) {
    inbound = await enrichInbound(ctx, inbound);
    await refreshSubmittedSweeps(ctx, inbound.token);
    sweepId = await matchSweep(ctx, inbound);
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

  // Источник неизвестен: если в сети есть sweep на ту же сумму — ждём его, иначе после выдержки считаем house funding.
  const candidate = await ctx.db
    .selectFrom('app.sweeps')
    .select('id')
    .where('token', '=', inbound.token)
    .where('status', 'in', ['PENDING', 'SUBMITTED'])
    .where('amount', '=', inbound.amount)
    .executeTakeFirst();
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

async function enrichInbound(ctx: AppContext, inbound: TreasuryInbound): Promise<TreasuryInbound> {
  if (inbound.tx_hash && inbound.source_address) return inbound;
  try {
    const tx = await ctx.circle.getTransaction(inbound.circle_transaction_id, 'INBOUND');
    if (tx.txHash || tx.sourceAddress) {
      return await ctx.db
        .updateTable('app.treasury_inbounds')
        .set({ tx_hash: inbound.tx_hash ?? tx.txHash, source_address: inbound.source_address ?? tx.sourceAddress })
        .where('id', '=', inbound.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    }
  } catch (error) {
    ctx.logger.warn({ err: error, treasuryInboundId: inbound.id }, 'failed to enrich treasury inbound');
  }
  return inbound;
}

/** У SCA txHash появляется только на CONFIRMED — подтягиваем свежие состояния sweep'ов без хэша. */
async function refreshSubmittedSweeps(ctx: AppContext, token: string): Promise<void> {
  const sweeps = await ctx.db
    .selectFrom('app.sweeps')
    .select(['id', 'circle_transaction_id'])
    .where('token', '=', token)
    .where('status', '=', 'SUBMITTED')
    .where('tx_hash', 'is', null)
    .limit(20)
    .execute();
  for (const sweep of sweeps) {
    if (!sweep.circle_transaction_id) continue;
    try {
      const tx = await ctx.circle.getTransaction(sweep.circle_transaction_id, 'OUTBOUND');
      await applySweepTransaction(ctx, tx, 'reconcile');
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
      await wakeJobs(trx, 'withdrawal.submit');
    }
    if (classification === 'UNCLASSIFIED') {
      ctx.logger.error({ treasuryInboundId: row.id }, 'treasury inbound could not be classified — manual review required');
    }
    return { type: 'done' as const, result: classification };
  });
}
