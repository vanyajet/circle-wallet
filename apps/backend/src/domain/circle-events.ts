/**
 * Единая точка применения транзакции Circle — и из вебхука, и из reconciliation.
 * Один код для обоих источников: поведение не расходится, а повторное применение безопасно
 * (монотонные статусы + exactly-once проводки).
 *
 * Маршрутизация по (направление, тип кошелька):
 *   INBOUND  → DEPOSIT   — депозит пользователя;
 *   INBOUND  → TREASURY  — нога sweep или house float (классификация);
 *   OUTBOUND ← TREASURY  — вывод;
 *   OUTBOUND ← DEPOSIT   — sweep.
 */
import type { CircleTransaction } from '../circle/gateway';
import type { AppContext } from './context';
import { applyDepositTransaction } from './deposits';
import { applySweepTransaction } from './sweeps';
import { applyTreasuryInboundTransaction } from './treasury';
import { applyWithdrawalTransaction } from './withdrawals';

export async function applyCircleTransaction(
  ctx: AppContext,
  tx: CircleTransaction,
  source: 'webhook' | 'reconcile',
): Promise<string> {
  if (!tx.walletId) return 'IGNORED:no_wallet_id';
  const wallet = await ctx.db
    .selectFrom('app.wallets')
    .selectAll()
    .where('circle_wallet_id', '=', tx.walletId)
    .executeTakeFirst();
  if (!wallet) return 'IGNORED:unknown_wallet';

  if (tx.transactionType === 'OUTBOUND') {
    return wallet.kind === 'TREASURY'
      ? applyWithdrawalTransaction(ctx, tx, source)
      : applySweepTransaction(ctx, tx, source);
  }

  // Входящие: только токены из allowlist — на адрес может прийти любой (в т.ч. спам) ERC-20.
  const token = ctx.tokens.byCircleTokenId(tx.tokenId);
  if (!token) return `IGNORED:unsupported_token:${tx.tokenId ?? 'none'}`;

  return wallet.kind === 'DEPOSIT'
    ? applyDepositTransaction(ctx, wallet, token, tx)
    : applyTreasuryInboundTransaction(ctx, wallet, token, tx);
}
