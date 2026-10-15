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
import { ensureJob } from '../jobs/queue';
import { applyCircleTransaction } from './circle-events';
import type { AppContext } from './context';
import { getAccountBalance, custody } from './ledger';

/** Операции «тише» этого порога не трогаем: даём шанс вебхуку. */
const STALE_AFTER = sql<Date>`now() - interval '30 seconds'`;
const RESUBMIT_AFTER = sql<Date>`now() - interval '2 minutes'`;
const BATCH = 25;
/** Перекрытие окна сканирования входящих: транзакция могла проиндексироваться у Circle с задержкой. */
const INBOUND_OVERLAP_MS = 15 * 60_000;
const INBOUND_CURSOR = 'reconcile.inbound';
const PAGE_SIZE = 50;
const MAX_INBOUND_PAGES = 20;

export async function reconcilePending(ctx: AppContext): Promise<string> {
  // Часть 1 (без вызовов Circle): у каждой незавершённой операции должна быть задача-«двигатель».
  // ensureJob не ставит дубль, пока такая задача ждёт или ВЫПОЛНЯЕТСЯ — иначе два воркера параллельно
  // повторяли бы отправку одного вывода.
  let requeued = 0;
  const pendingWithdrawals = await ctx.db
    .selectFrom('app.withdrawals')
    .select('id')
    .where('status', 'in', ['PENDING', 'SUBMITTING'])
    .where('updated_at', '<', RESUBMIT_AFTER)
    .limit(500)
    .execute();
  for (const w of pendingWithdrawals) {
    await ensureJob(ctx.db, 'withdrawal.submit', { withdrawalId: w.id }, `withdrawal:${w.id}`);
    requeued++;
  }
  const pendingSweeps = await ctx.db
    .selectFrom('app.sweeps')
    .select(['wallet_id', 'token'])
    .where('status', '=', 'PENDING')
    .where('updated_at', '<', RESUBMIT_AFTER)
    .limit(500)
    .execute();
  for (const s of pendingSweeps) {
    await ensureJob(ctx.db, 'sweep.schedule', { walletId: s.wallet_id, token: s.token }, `sweep:${s.wallet_id}:${s.token}`);
    requeued++;
  }
  const completedInbounds = await ctx.db
    .selectFrom('app.treasury_inbounds')
    .select('id')
    .where('classification', '=', 'PENDING')
    .where('circle_state', '=', 'COMPLETE')
    .where('updated_at', '<', STALE_AFTER)
    .limit(500)
    .execute();
  for (const i of completedInbounds) {
    await ensureJob(ctx.db, 'treasury-inbound.classify', { treasuryInboundId: i.id }, `treasury-inbound:${i.id}`);
    requeued++;
  }
  const pendingWallets = await ctx.db
    .selectFrom('app.wallets')
    .select('id')
    .where('status', '=', 'PENDING')
    .where('created_at', '<', RESUBMIT_AFTER)
    .limit(500)
    .execute();
  for (const w of pendingWallets) {
    await ensureJob(ctx.db, 'wallet.create', { walletId: w.id }, `wallet:${w.id}`);
    requeued++;
  }

  // Часть 2: опрос Circle по операциям «в сети». Порядок — по last_reconciled_at (nulls first):
  // каждая проверка отправляет строку в конец очереди, поэтому «застрявшие» не вытесняют остальные.
  let refreshed = 0;
  const refresh = async (
    table: 'app.withdrawals' | 'app.sweeps' | 'app.deposits' | 'app.treasury_inbounds',
    id: string,
    circleTxId: string,
    txType: CircleTxType,
  ) => {
    try {
      // txType обязателен: у внутреннего перевода ноги делят id (см. CircleGateway.getTransaction).
      const tx = await ctx.circle.getTransaction(circleTxId, txType);
      await applyCircleTransaction(ctx, tx, 'reconcile');
      refreshed++;
    } catch (error) {
      ctx.logger.warn({ err: error, circleTxId, table }, 'reconcile: failed to refresh transaction');
    } finally {
      await ctx.db.updateTable(table).set({ last_reconciled_at: new Date() }).where('id', '=', id).execute();
    }
  };

  const submittedWithdrawals = await ctx.db
    .selectFrom('app.withdrawals')
    .select(['id', 'circle_transaction_id'])
    .where('status', '=', 'SUBMITTED')
    .where('updated_at', '<', STALE_AFTER)
    .where((eb) => eb.or([eb('last_reconciled_at', 'is', null), eb('last_reconciled_at', '<', STALE_AFTER)]))
    .orderBy(sql`last_reconciled_at nulls first`)
    .limit(BATCH)
    .execute();
  for (const w of submittedWithdrawals) {
    if (w.circle_transaction_id) await refresh('app.withdrawals', w.id, w.circle_transaction_id, 'OUTBOUND');
  }

  const submittedSweeps = await ctx.db
    .selectFrom('app.sweeps')
    .select(['id', 'circle_transaction_id'])
    .where('status', '=', 'SUBMITTED')
    .where('updated_at', '<', STALE_AFTER)
    .where((eb) => eb.or([eb('last_reconciled_at', 'is', null), eb('last_reconciled_at', '<', STALE_AFTER)]))
    .orderBy(sql`last_reconciled_at nulls first`)
    .limit(BATCH)
    .execute();
  for (const s of submittedSweeps) {
    if (s.circle_transaction_id) await refresh('app.sweeps', s.id, s.circle_transaction_id, 'OUTBOUND');
  }

  const pendingDeposits = await ctx.db
    .selectFrom('app.deposits')
    .select(['id', 'circle_transaction_id'])
    .where('status', '=', 'PENDING')
    .where('updated_at', '<', STALE_AFTER)
    .where((eb) => eb.or([eb('last_reconciled_at', 'is', null), eb('last_reconciled_at', '<', STALE_AFTER)]))
    .orderBy(sql`last_reconciled_at nulls first`)
    .limit(BATCH)
    .execute();
  for (const d of pendingDeposits) await refresh('app.deposits', d.id, d.circle_transaction_id, 'INBOUND');

  const openInbounds = await ctx.db
    .selectFrom('app.treasury_inbounds')
    .select(['id', 'circle_transaction_id'])
    .where('classification', '=', 'PENDING')
    .where('circle_state', '<>', 'COMPLETE')
    .where('updated_at', '<', STALE_AFTER)
    .where((eb) => eb.or([eb('last_reconciled_at', 'is', null), eb('last_reconciled_at', '<', STALE_AFTER)]))
    .orderBy(sql`last_reconciled_at nulls first`)
    .limit(BATCH)
    .execute();
  for (const i of openInbounds) await refresh('app.treasury_inbounds', i.id, i.circle_transaction_id, 'INBOUND');

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
      let exhausted = false;
      for (let page = 0; page < MAX_INBOUND_PAGES; page++) {
        const result = await ctx.circle.listTransactions({
          walletIds: chunk,
          txType: 'INBOUND',
          from: since.toISOString(),
          ...(pageAfter ? { pageAfter } : {}),
          pageSize: PAGE_SIZE,
        });
        for (const tx of result.items) {
          seen++;
          try {
            await applyCircleTransaction(ctx, tx, 'reconcile');
          } catch (error) {
            ctx.logger.warn({ err: error, circleTxId: tx.id }, 'reconcile.inbound: failed to apply transaction');
          }
        }
        // Курсор из Link; если заголовка нет, но страница полная — продолжаем от последнего элемента.
        const next = result.nextPageAfter ?? (result.items.length === PAGE_SIZE ? result.items.at(-1)!.id : null);
        if (!next || result.items.length === 0) {
          exhausted = true;
          break;
        }
        pageAfter = next;
      }
      // Упёрлись в лимит страниц — окно просмотрено не целиком: курсор двигать нельзя.
      if (!exhausted) failedChunks++;
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
    .select(['id', 'kind', 'circle_wallet_id'])
    .where('status', '=', 'ACTIVE')
    .where('circle_wallet_id', 'is not', null)
    .execute();
  let checked = 0;
  let mismatches = 0;
  for (const wallet of wallets) {
    try {
      const balances = await ctx.circle.getWalletBalances(wallet.circle_wallet_id!);
      for (const token of ctx.tokens.all()) {
        const onChainRaw = balances.find((b) => b.tokenId === token.circle_token_id)?.amount ?? '0';
        const onChain = parseUnits(onChainRaw, token.decimals);
        const ledger = await getAccountBalance(ctx.db, custody(wallet.id, token.symbol));
        const inFlightOut = await outgoingInFlight(ctx, wallet.id, wallet.kind, token.symbol);
        if (onChain === 0n && ledger === 0n && inFlightOut === 0n) {
          // Пустой кошелёк — сверять нечего; убираем прошлый результат, иначе на /ops осталась бы устаревшая
          // «разница» от момента, когда sweep был в пути.
          await ctx.db
            .deleteFrom('app.balance_checks')
            .where('wallet_id', '=', wallet.id)
            .where('token', '=', token.symbol)
            .execute();
          continue;
        }
        const values = {
          ledger_custody: ledger.toString(),
          in_flight_out: inFlightOut.toString(),
          on_chain: onChain.toString(),
        };
        await ctx.db
          .insertInto('app.balance_checks')
          .values({ wallet_id: wallet.id, token: token.symbol, ...values })
          .onConflict((oc) => oc.columns(['wallet_id', 'token']).doUpdateSet({ ...values, checked_at: new Date() }))
          .execute();
        // Ожидаемый on-chain = CUSTODY − исходящие в пути. Меньше — тревога: такого быть не должно.
        if (onChain < ledger - inFlightOut) {
          mismatches++;
          ctx.logger.error(
            { walletId: wallet.id, token: token.symbol, ...values },
            'custody mismatch: on-chain below expected ledger balance',
          );
        }
        checked++;
      }
    } catch (error) {
      ctx.logger.warn({ err: error, walletId: wallet.id }, 'reconcile.balances: failed to fetch balances');
    }
  }
  return `checked=${checked} mismatches=${mismatches}`;
}

/**
 * Исходящие переводы кошелька, которые могли уже уйти on-chain, но ещё не проведены в леджере:
 * для deposit-кошелька — незавершённые sweep, для treasury — выводы в SUBMITTING/SUBMITTED.
 */
async function outgoingInFlight(ctx: AppContext, walletId: string, kind: 'DEPOSIT' | 'TREASURY', token: string): Promise<bigint> {
  const row =
    kind === 'DEPOSIT'
      ? await ctx.db
          .selectFrom('app.sweeps')
          .select(sql<string>`coalesce(sum(amount), 0)::text`.as('total'))
          .where('wallet_id', '=', walletId)
          .where('token', '=', token)
          .where('status', 'in', ['PENDING', 'SUBMITTED'])
          .executeTakeFirstOrThrow()
      : await ctx.db
          .selectFrom('app.withdrawals')
          .select(sql<string>`coalesce(sum(amount), 0)::text`.as('total'))
          .where('token', '=', token)
          .where('status', 'in', ['SUBMITTING', 'SUBMITTED'])
          .executeTakeFirstOrThrow();
  return BigInt(row.total);
}
