/**
 * Применение входящей транзакции на deposit-кошелёк пользователя (design-doc §8.2).
 *
 * Зачисление (DEPOSIT_CREDIT) — только на переходе в COMPLETE: до этого возможен reorg (FAILED_REORG),
 * поэтому CONFIRMED показывается как «в обработке», но в баланс не попадает.
 * Вместе с зачислением в той же транзакции ставится задача sweep.schedule (outbox).
 */
import { parseUnits } from '@circle-wallet/shared';
import type { CircleTransaction } from '../circle/gateway';
import type { DepositStatus, Token, Wallet } from '../db/schema';
import { enqueueJob } from '../jobs/queue';
import { isFailureState, isSuccessState, shouldApplyState } from './circle-state';
import type { AppContext } from './context';
import { custody, postLedgerTransaction, userAvailable } from './ledger';

export function depositStatusFor(state: string): DepositStatus {
  if (isSuccessState(state)) return 'COMPLETED';
  if (isFailureState(state)) return 'FAILED';
  return 'PENDING';
}

export async function applyDepositTransaction(
  ctx: AppContext,
  wallet: Wallet,
  token: Token,
  tx: CircleTransaction,
): Promise<string> {
  if (!tx.amount) return 'IGNORED:no_amount';
  const amount = parseUnits(tx.amount, token.decimals);
  if (amount <= 0n) return 'IGNORED:zero_amount';

  return ctx.db.transaction().execute(async (trx) => {
    // Upsert + row lock: параллельные события по одной транзакции Circle сериализуются на этой строке.
    const inserted = await trx
      .insertInto('app.deposits')
      .values({
        user_id: wallet.user_id!,
        wallet_id: wallet.id,
        token: token.symbol,
        amount: amount.toString(),
        status: 'PENDING',
        circle_transaction_id: tx.id,
        circle_state: tx.state,
        tx_hash: tx.txHash,
        source_address: tx.sourceAddress,
      })
      .onConflict((oc) => oc.column('circle_transaction_id').doNothing())
      .returning('id')
      .executeTakeFirst();

    const deposit = await trx
      .selectFrom('app.deposits')
      .selectAll()
      .where('circle_transaction_id', '=', tx.id)
      .forUpdate()
      .executeTakeFirstOrThrow();

    // Для только что вставленной строки «текущего» состояния ещё не было.
    const previousState = inserted ? null : deposit.circle_state;
    if (!shouldApplyState(previousState, tx.state)) return 'NOOP:stale_state';

    const previousStatus = inserted ? 'PENDING' : deposit.status;
    const nextStatus = depositStatusFor(tx.state);
    await trx
      .updateTable('app.deposits')
      .set({
        circle_state: tx.state,
        status: nextStatus,
        tx_hash: tx.txHash ?? deposit.tx_hash,
        source_address: tx.sourceAddress ?? deposit.source_address,
        error_reason: tx.errorReason,
        error_details: tx.errorDetails,
        ...(nextStatus === 'COMPLETED' ? { completed_at: new Date() } : {}),
      })
      .where('id', '=', deposit.id)
      .execute();

    if (nextStatus === 'COMPLETED' && previousStatus !== 'COMPLETED') {
      const result = await postLedgerTransaction(trx, {
        kind: 'DEPOSIT_CREDIT',
        referenceId: deposit.id,
        description: `Deposit ${tx.id}`,
        lines: [
          { account: custody(wallet.id, token.symbol), direction: 'DEBIT', amount },
          { account: userAvailable(wallet.user_id!, token.symbol), direction: 'CREDIT', amount },
        ],
      });
      await enqueueJob(
        trx,
        'sweep.schedule',
        { walletId: wallet.id, token: token.symbol },
        { dedupeKey: `sweep:${wallet.id}:${token.symbol}` },
      );
      ctx.logger.info({ depositId: deposit.id, amount: tx.amount, token: token.symbol, result }, 'deposit credited');
      return `APPLIED:${nextStatus}`;
    }
    return `APPLIED:${nextStatus}`;
  });
}
