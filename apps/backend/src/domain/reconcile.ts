/**
 * Reconciliation (design-doc §11): корректность не зависит от доставки вебхуков.
 *
 *  - pending:  опрос Circle по незавершённым операциям (тем же кодом, что и вебхуки);
 *  - inbound:  поиск пропущенных входящих транзакций по всем нашим кошелькам с курсором;
 *  - balances: сверка CUSTODY леджера с on-chain балансами кошельков.
 * Всё здесь fail soft: ошибка по одной операции логируется и не мешает остальным.
 */
import { parseUnits } from '@circle-wallet/shared';
import { sql } from 'kysely';
import type { CircleTxType } from '../circle/gateway';
import { enqueueJob } from '../jobs/queue';
import { applyCircleTransaction } from './circle-events';
import type { AppContext } from './context';
import { getAccountBalance, custody } from './ledger';

/** Операции «тише» этого порога не трогаем: даём шанс вебхуку. */
const STALE_AFTER = sql<Date>`now() - interval '30 seconds'`;
const RESUBMIT_AFTER = sql<Date>`now() - interval '2 minutes'`;
const BATCH = 50;
/** Перекрытие окна сканирования входящих: транзакция могла проиндексироваться у Circle с задержкой. */
const INBOUND_OVERLAP_MS = 15 * 60_000;
const INBOUND_CURSOR = 'reconcile.inbound';

export async function reconcilePending(ctx: AppContext): Promise<string> {
  let refreshed = 0;
  let requeued = 0;

  const refresh = async (circleTxId: string, txType: CircleTxType, label: string) => {
    try {
      // txType обязателен: у внутреннего перевода ноги делят id (см. CircleGateway.getTransaction).
      const tx = await ctx.circle.getTransaction(circleTxId, txType);
      await applyCircleTransaction(ctx, tx, 'reconcile');
      refreshed++;
    } catch (error) {
      ctx.logger.warn({ err: error, circleTxId, label }, 'reconcile: failed to refresh transaction');
    }
  };

  const withdrawals = await ctx.db
    .selectFrom('app.withdrawals')
    .select(['id', 'status', 'circle_transaction_id'])
    .where('status', 'in', ['PENDING', 'SUBMITTING', 'SUBMITTED'])
    .where('updated_at', '<', STALE_AFTER)
    .orderBy('updated_at')
    .limit(BATCH)
    .execute();
  for (const w of withdrawals) {
    if (w.status === 'SUBMITTED' && w.circle_transaction_id) {
      await refresh(w.circle_transaction_id, 'OUTBOUND', `withdrawal:${w.id}`);
    } else {
      // PENDING/SUBMITTING: гарантируем, что задача отправки существует (например, если прошлая ушла в DEAD).
      await enqueueJob(ctx.db, 'withdrawal.submit', { withdrawalId: w.id }, { dedupeKey: `withdrawal:${w.id}` });
      requeued++;
    }
  }

  const sweeps = await ctx.db
    .selectFrom('app.sweeps')
    .select(['id', 'status', 'wallet_id', 'token', 'circle_transaction_id'])
    .where('status', 'in', ['PENDING', 'SUBMITTED'])
    .where('updated_at', '<', STALE_AFTER)
    .limit(BATCH)
    .execute();
  for (const s of sweeps) {
    if (s.status === 'SUBMITTED' && s.circle_transaction_id) {
      await refresh(s.circle_transaction_id, 'OUTBOUND', `sweep:${s.id}`);
    } else {
      await enqueueJob(ctx.db, 'sweep.schedule', { walletId: s.wallet_id, token: s.token }, { dedupeKey: `sweep:${s.wallet_id}:${s.token}` });
      requeued++;
    }
  }

  const deposits = await ctx.db
    .selectFrom('app.deposits')
    .select(['id', 'circle_transaction_id'])
    .where('status', '=', 'PENDING')
    .where('updated_at', '<', STALE_AFTER)
    .limit(BATCH)
    .execute();
  for (const d of deposits) await refresh(d.circle_transaction_id, 'INBOUND', `deposit:${d.id}`);

  const inbounds = await ctx.db
    .selectFrom('app.treasury_inbounds')
    .select(['id', 'circle_transaction_id', 'circle_state', 'classification'])
    .where('classification', '=', 'PENDING')
    .where('updated_at', '<', STALE_AFTER)
    .limit(BATCH)
    .execute();
  for (const i of inbounds) {
    if (i.circle_state === 'COMPLETE') {
      await enqueueJob(ctx.db, 'treasury-inbound.classify', { treasuryInboundId: i.id }, { dedupeKey: `treasury-inbound:${i.id}` });
      requeued++;
    } else {
      await refresh(i.circle_transaction_id, 'INBOUND', `treasury-inbound:${i.id}`);
    }
  }

  const wallets = await ctx.db
    .selectFrom('app.wallets')
    .select('id')
    .where('status', '=', 'PENDING')
    .where('created_at', '<', RESUBMIT_AFTER)
    .limit(BATCH)
    .execute();
  for (const w of wallets) {
    await enqueueJob(ctx.db, 'wallet.create', { walletId: w.id }, { dedupeKey: `wallet:${w.id}` });
    requeued++;
  }

  return `refreshed=${refreshed} requeued=${requeued}`;
}

export async function reconcileInbound(ctx: AppContext): Promise<string> {
  const startedAt = new Date();
  const cursorRow = await ctx.db
    .selectFrom('app.sync_cursors')
    .select('cursor')
    .where('name', '=', INBOUND_CURSOR)
    .executeTakeFirst();
  // Первый запуск — сканируем последние сутки (этого хватает, чтобы подобрать всё, что пришло до старта worker'а).
  const since = cursorRow ? new Date(cursorRow.cursor.getTime() - INBOUND_OVERLAP_MS) : new Date(Date.now() - 24 * 3600_000);

  const wallets = await ctx.db
    .selectFrom('app.wallets')
    .select('circle_wallet_id')
    .where('status', '=', 'ACTIVE')
    .where('circle_wallet_id', 'is not', null)
    .execute();
  const walletIds = wallets.map((w) => w.circle_wallet_id!);

  let seen = 0;
  let failedChunks = 0;
  for (let i = 0; i < walletIds.length; i += 20) {
    const chunk = walletIds.slice(i, i + 20);
    let pageAfter: string | undefined;
    try {
      // Ограничение числа страниц — защита от бесконечного цикла при некорректной пагинации.
      for (let page = 0; page < 20; page++) {
        const result = await ctx.circle.listTransactions({
          walletIds: chunk,
          txType: 'INBOUND',
          from: since.toISOString(),
          ...(pageAfter ? { pageAfter } : {}),
          pageSize: 50,
        });
        for (const tx of result.items) {
          seen++;
          try {
            await applyCircleTransaction(ctx, tx, 'reconcile');
          } catch (error) {
            ctx.logger.warn({ err: error, circleTxId: tx.id }, 'reconcile.inbound: failed to apply transaction');
          }
        }
        if (!result.nextPageAfter || result.items.length === 0) break;
        pageAfter = result.nextPageAfter;
      }
    } catch (error) {
      failedChunks++;
      ctx.logger.warn({ err: error }, 'reconcile.inbound: list transactions failed');
    }
  }

  // Курсор двигаем, только если все запросы прошли: иначе следующий запуск повторит окно.
  if (failedChunks === 0) {
    await ctx.db
      .insertInto('app.sync_cursors')
      .values({ name: INBOUND_CURSOR, cursor: startedAt })
      .onConflict((oc) => oc.column('name').doUpdateSet({ cursor: startedAt, updated_at: new Date() }))
      .execute();
  }
  return `seen=${seen} wallets=${walletIds.length} failedChunks=${failedChunks}`;
}

export async function reconcileBalances(ctx: AppContext): Promise<string> {
  const wallets = await ctx.db
    .selectFrom('app.wallets')
    .select(['id', 'circle_wallet_id'])
    .where('status', '=', 'ACTIVE')
    .where('circle_wallet_id', 'is not', null)
    .execute();
  let checked = 0;
  for (const wallet of wallets) {
    try {
      const balances = await ctx.circle.getWalletBalances(wallet.circle_wallet_id!);
      for (const token of ctx.tokens.all()) {
        const onChainRaw = balances.find((b) => b.tokenId === token.circle_token_id)?.amount ?? '0';
        const onChain = parseUnits(onChainRaw, token.decimals);
        const ledger = await getAccountBalance(ctx.db, custody(wallet.id, token.symbol));
        if (onChain === 0n && ledger === 0n) continue;
        await ctx.db
          .insertInto('app.balance_checks')
          .values({ wallet_id: wallet.id, token: token.symbol, ledger_custody: ledger.toString(), on_chain: onChain.toString() })
          .onConflict((oc) =>
            oc.columns(['wallet_id', 'token']).doUpdateSet({
              ledger_custody: ledger.toString(),
              on_chain: onChain.toString(),
              checked_at: new Date(),
            }),
          )
          .execute();
        if (onChain < ledger) {
          // На кошельке меньше, чем учтено в леджере — тревога: такого быть не должно.
          ctx.logger.error({ walletId: wallet.id, token: token.symbol, ledger: ledger.toString(), onChain: onChain.toString() }, 'custody mismatch: on-chain below ledger');
        }
        checked++;
      }
    } catch (error) {
      ctx.logger.warn({ err: error, walletId: wallet.id }, 'reconcile.balances: failed to fetch balances');
    }
  }
  return `checked=${checked}`;
}
