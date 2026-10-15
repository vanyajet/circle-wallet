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
import { isCircleError } from '../circle/errors';
import type { CircleTransaction } from '../circle/gateway';
import type { Tx } from '../db/client';
import type { Sweep, SweepStatus, Wallet } from '../db/schema';
import { enqueueJob, wakeJobs } from '../jobs/queue';
import { isFailureState, isSuccessState, isTerminalState, shouldApplyState } from './circle-state';
import type { AppContext } from './context';
import { RetryLaterError } from './context';
import { custody, lockAccount, postLedgerTransaction } from './ledger';
import { requireTreasuryWallet } from './wallets';

export const sweepRefId = (id: string) => `sweep:${id}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const scheduleSweep = (trx: Tx, walletId: string, token: string, runAt?: Date) =>
  enqueueJob(trx, 'sweep.schedule', { walletId, token }, { dedupeKey: `sweep:${walletId}:${token}`, ...(runAt ? { runAt } : {}) });

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
    if (active) return { type: 'submit' as const, sweep: active, wallet };

    if (walletCustody.balance <= 0n || walletCustody.balance < threshold) {
      return { type: 'skip' as const, result: 'NOOP:below_threshold' };
    }
    const sweep = await trx
      .insertInto('app.sweeps')
      .values({ wallet_id: wallet.id, token: token.symbol, amount: walletCustody.balance.toString() })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { type: 'submit' as const, sweep, wallet };
  });

  if (decision.type === 'skip') return decision.result;
  return submitSweep(ctx, decision.sweep, decision.wallet);
}

async function submitSweep(ctx: AppContext, sweep: Sweep, wallet: Wallet): Promise<string> {
  const treasury = await requireTreasuryWallet(ctx.db);
  const token = ctx.tokens.bySymbol(sweep.token)!;
  try {
    const created = await ctx.circle.createTransfer({
      // id sweep — детерминированный ключ: повтор после сбоя не создаст второй перевод.
      idempotencyKey: sweep.id,
      walletId: wallet.circle_wallet_id!,
      tokenId: token.circle_token_id,
      destinationAddress: treasury.address,
      amount: formatUnits(BigInt(sweep.amount), token.decimals),
      refId: sweepRefId(sweep.id),
    });
    await ctx.db
      .updateTable('app.sweeps')
      .set({ status: 'SUBMITTED', circle_transaction_id: created.id, circle_state: created.state, submitted_at: new Date() })
      .where('id', '=', sweep.id)
      .where('status', '=', 'PENDING')
      .execute();
    ctx.logger.info({ sweepId: sweep.id, amount: sweep.amount, token: sweep.token }, 'sweep submitted');
    return 'SUBMITTED';
  } catch (error) {
    if (isCircleError(error) && error.kind === 'DEFINITIVE') {
      // Перевод точно не создан: помечаем FAILED (проводок не было) и пробуем позже новым sweep.
      await ctx.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('app.sweeps')
          .set({ status: 'FAILED', error_reason: 'REJECTED_BY_CIRCLE', error_details: error.message, completed_at: new Date() })
          .where('id', '=', sweep.id)
          .where('status', '=', 'PENDING')
          .execute();
        await scheduleSweep(trx, sweep.wallet_id, sweep.token, new Date(Date.now() + 5 * 60_000));
      });
      return 'FAILED:rejected';
    }
    throw error;
  }
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
      await wakeJobs(trx, 'withdrawal.submit');
      // Входящее на treasury по этому sweep можно классифицировать сразу.
      await wakeJobs(trx, 'treasury-inbound.classify');
    } else if (nextStatus === 'FAILED') {
      await scheduleSweep(trx, sweep.wallet_id, sweep.token, new Date(Date.now() + 60_000));
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
