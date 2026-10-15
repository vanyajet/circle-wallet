/**
 * Sweep: перемещение средств с deposit-кошелька пользователя на treasury (omnibus, ADR-0001).
 *
 *  - запускается только после COMPLETE депозита (задача sweep.schedule ставится вместе с зачислением);
 *  - сумма берётся из леджера (CUSTODY кошелька — только финализированные депозиты allowlist-токенов),
 *    а не из on-chain баланса: так мы не сметём то, что ещё может откатиться, и не тронем спам-токены;
 *  - мелочь ниже порога SWEEP_MIN_AMOUNT не сметаем (в проде газ стоит денег);
 *  - один активный sweep на (кошелёк, токен) — partial unique index в БД;
 *  - в леджере sweep проводится по СВОЕЙ outbound-транзакции (SWEEP_SETTLE на COMPLETE).
 */
import { formatUnits, parseUnits } from '@circle-wallet/shared';
import { sql } from 'kysely';
import { isCircleError } from '../circle/errors';
import type { CircleTransaction } from '../circle/gateway';
import type { Tx } from '../db/client';
import type { Sweep, SweepStatus, Wallet } from '../db/schema';
import { enqueueJob, wakeTreasuryClassification, wakeWithdrawalsAwaitingLiquidity } from '../jobs/queue';
import { isFailureState, isSuccessState, isTerminalState, shouldApplyState } from './circle-state';
import type { AppContext } from './context';
import { RetryLaterError } from './context';
import { custody, lockAccount, postLedgerTransaction } from './ledger';
import { requireTreasuryWallet } from './wallets';

export const sweepRefId = (id: string) => `sweep:${id}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const scheduleSweep = (trx: Tx, walletId: string, token: string, delayMs = 0) =>
  enqueueJob(trx, 'sweep.schedule', { walletId, token }, { dedupeKey: `sweep:${walletId}:${token}`, delayMs });

/** После стольких неудачных sweep за час автоматические повторы прекращаются (ошибка в логах, ручной разбор). */
const MAX_FAILED_SWEEPS_PER_HOUR = 3;

/** Задача sweep.schedule: решить, нужен ли sweep, создать его и отправить в Circle. */
export async function runSweep(ctx: AppContext, walletId: string, tokenSymbol: string): Promise<string> {
  const token = ctx.tokens.bySymbol(tokenSymbol);
  if (!token) return 'IGNORED:unsupported_token';
  const threshold = parseUnits(ctx.settings.sweepMinAmount, token.decimals);

  const decision = await ctx.db.transaction().execute(async (trx) => {
    const wallet = await trx.selectFrom('app.wallets').selectAll().where('id', '=', walletId).executeTakeFirst();
    if (!wallet || wallet.kind !== 'DEPOSIT' || wallet.status !== 'ACTIVE' || !wallet.circle_wallet_id) {
      return { type: 'skip' as const, result: 'IGNORED:wallet_not_active' };
    }
    // Блокируем CUSTODY кошелька: параллельные sweep.schedule по одному кошельку сериализуются.
    const walletCustody = await lockAccount(trx, custody(wallet.id, token.symbol));
    const active = await trx
      .selectFrom('app.sweeps')
      .selectAll()
      .where('wallet_id', '=', wallet.id)
      .where('token', '=', token.symbol)
      .where('status', 'in', ['PENDING', 'SUBMITTED'])
      .executeTakeFirst();
    if (active?.status === 'SUBMITTED') {
      // Уже в сети; после его COMPLETE остаток (если пришёл новый депозит) сметётся следующим sweep.
      return { type: 'skip' as const, result: 'NOOP:sweep_in_flight' };
    }
    // Незавершённый PENDING sweep от прошлого запуска: его перевод мог уже уйти в Circle (ответ потерялся).
    if (active) return { type: 'submit' as const, sweep: active, wallet, fresh: false };

    if (walletCustody.balance <= 0n || walletCustody.balance < threshold) {
      return { type: 'skip' as const, result: 'NOOP:below_threshold' };
    }
    const sweep = await trx
      .insertInto('app.sweeps')
      .values({ wallet_id: wallet.id, token: token.symbol, amount: walletCustody.balance.toString() })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { type: 'submit' as const, sweep, wallet, fresh: true };
  });

  if (decision.type === 'skip') return decision.result;
  return submitSweep(ctx, decision.sweep, decision.wallet, decision.fresh);
}

async function submitSweep(ctx: AppContext, sweep: Sweep, wallet: Wallet, fresh: boolean): Promise<string> {
  const treasury = await requireTreasuryWallet(ctx.db);
  const token = ctx.tokens.bySymbol(sweep.token)!;
  let created: { id: string; state: string };
  try {
    created = await ctx.circle.createTransfer({
      // id sweep — детерминированный ключ: повтор после сбоя не создаст второй перевод.
      idempotencyKey: sweep.id,
      walletId: wallet.circle_wallet_id!,
      tokenId: token.circle_token_id,
      destinationAddress: treasury.address,
      amount: formatUnits(BigInt(sweep.amount), token.decimals),
      refId: sweepRefId(sweep.id),
    });
  } catch (error) {
    if (isCircleError(error) && error.kind === 'DEFINITIVE' && fresh) {
      // Первая попытка отклонена по существу — перевод точно не создан: FAILED (проводок не было), повтор позже.
      await ctx.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('app.sweeps')
          .set({ status: 'FAILED', error_reason: 'REJECTED_BY_CIRCLE', error_details: error.message, completed_at: new Date() })
          .where('id', '=', sweep.id)
          .where('status', '=', 'PENDING')
          .execute();
        await rescheduleAfterFailure(ctx, trx, sweep);
      });
      return 'FAILED:rejected';
    }
    // Неизвестный исход, временная ошибка или отказ на ПОВТОР (перевод мог быть создан первой попыткой) —
    // sweep остаётся PENDING с тем же idempotencyKey, задача повторится.
    throw error;
  }

  // Ответ применяем через ту же state machine, что и вебхуки (повтор может вернуть уже терминальное состояние).
  const result = await applySweepTransaction(
    ctx,
    {
      id: created.id,
      transactionType: 'OUTBOUND',
      state: created.state,
      walletId: wallet.circle_wallet_id,
      tokenId: token.circle_token_id,
      amount: null,
      txHash: null,
      refId: sweepRefId(sweep.id),
      sourceAddress: wallet.address,
      destinationAddress: treasury.address,
      errorReason: null,
      errorDetails: null,
    },
    'reconcile',
  );
  ctx.logger.info({ sweepId: sweep.id, amount: sweep.amount, token: sweep.token, result }, 'sweep submitted');
  return 'SUBMITTED';
}

/** Повтор sweep после неудачи — с паузой и ограничением, чтобы не крутить бесконечный цикл (например, лимит Gas Station). */
async function rescheduleAfterFailure(ctx: AppContext, trx: Tx, sweep: Pick<Sweep, 'wallet_id' | 'token'>): Promise<void> {
  const recent = await trx
    .selectFrom('app.sweeps')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('wallet_id', '=', sweep.wallet_id)
    .where('token', '=', sweep.token)
    .where('status', '=', 'FAILED')
    .where('created_at', '>', sql<Date>`now() - interval '1 hour'`)
    .executeTakeFirstOrThrow();
  if (recent.n >= MAX_FAILED_SWEEPS_PER_HOUR) {
    ctx.logger.error({ walletId: sweep.wallet_id, token: sweep.token, failures: recent.n }, 'sweep keeps failing — automatic retries paused');
    return;
  }
  await scheduleSweep(trx, sweep.wallet_id, sweep.token, 5 * 60_000 * recent.n + 60_000);
}

export function sweepStatusFor(state: string): SweepStatus {
  if (isSuccessState(state)) return 'COMPLETED';
  if (isFailureState(state)) return 'FAILED';
  return 'SUBMITTED';
}

/** Outbound-транзакция с deposit-кошелька = нога sweep. */
export async function applySweepTransaction(
  ctx: AppContext,
  tx: CircleTransaction,
  source: 'webhook' | 'reconcile',
): Promise<string> {
  const result = await ctx.db.transaction().execute(async (trx) => {
    const sweep = await findSweepForTransaction(trx, tx);
    if (!sweep) {
      if (source === 'webhook') throw new RetryLaterError(`sweep for Circle tx ${tx.id} not found yet`);
      return 'IGNORED:unknown_outbound';
    }
    if (sweep.status === 'COMPLETED' || sweep.status === 'FAILED') return `NOOP:${sweep.status}`;
    if (!shouldApplyState(sweep.circle_state, tx.state)) {
      if (!sweep.tx_hash && tx.txHash) {
        await trx.updateTable('app.sweeps').set({ tx_hash: tx.txHash }).where('id', '=', sweep.id).execute();
      }
      return 'NOOP:stale_state';
    }

    const nextStatus = sweepStatusFor(tx.state);
    await trx
      .updateTable('app.sweeps')
      .set({
        status: nextStatus,
        circle_transaction_id: sweep.circle_transaction_id ?? tx.id,
        circle_state: tx.state,
        tx_hash: tx.txHash ?? sweep.tx_hash,
        error_reason: tx.errorReason,
        error_details: tx.errorDetails,
        submitted_at: sweep.submitted_at ?? new Date(),
        ...(isTerminalState(tx.state) ? { completed_at: new Date() } : {}),
      })
      .where('id', '=', sweep.id)
      .execute();

    if (nextStatus === 'COMPLETED') {
      const treasury = await requireTreasuryWallet(trx);
      const amount = BigInt(sweep.amount);
      await postLedgerTransaction(trx, {
        kind: 'SWEEP_SETTLE',
        referenceId: sweep.id,
        description: `Sweep ${tx.id}`,
        lines: [
          { account: custody(treasury.id, sweep.token), direction: 'DEBIT', amount },
          { account: custody(sweep.wallet_id, sweep.token), direction: 'CREDIT', amount },
        ],
      });
      // Пока sweep был в сети, мог прийти новый депозит — проверим остаток.
      await scheduleSweep(trx, sweep.wallet_id, sweep.token);
      // Ликвидность treasury выросла — будим выводы, ждущие её.
      await wakeWithdrawalsAwaitingLiquidity(trx);
      // Входящее на treasury по этому sweep можно классифицировать сразу.
      await wakeTreasuryClassification(trx);
    } else if (nextStatus === 'FAILED') {
      await rescheduleAfterFailure(ctx, trx, sweep);
    }
    return `APPLIED:${nextStatus}`;
  });
  return result;
}

async function findSweepForTransaction(trx: Tx, tx: CircleTransaction): Promise<Sweep | undefined> {
  const byCircleId = await trx
    .selectFrom('app.sweeps')
    .selectAll()
    .where('circle_transaction_id', '=', tx.id)
    .forUpdate()
    .executeTakeFirst();
  if (byCircleId) return byCircleId;
  const prefix = 'sweep:';
  const id = tx.refId?.startsWith(prefix) ? tx.refId.slice(prefix.length) : null;
  if (!id || !UUID_RE.test(id)) return undefined;
  return trx.selectFrom('app.sweeps').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
}
