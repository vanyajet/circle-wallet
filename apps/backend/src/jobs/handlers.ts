/**
 * Обработчики задач. Каждый обработчик идемпотентен: задачу могут выполнить повторно
 * (истёк lease, воркер упал после side effect, но до complete) — и это должно быть безопасно.
 */
import { z } from 'zod';
import type { AppContext } from '../domain/context';
import { reconcileBalances, reconcileInbound, reconcilePending } from '../domain/reconcile';
import { runSweep } from '../domain/sweeps';
import { classifyTreasuryInbound } from '../domain/treasury';
import { createDepositWallet } from '../domain/wallets';
import { processWebhookEvent } from '../domain/webhooks';
import { submitWithdrawal } from '../domain/withdrawals';
import type { JobKind } from './queue';

export type HandlerResult =
  | { type: 'done'; result?: string }
  /** Вернуть в очередь без расхода попытки — ожидание, а не сбой (например, ликвидности treasury). */
  | { type: 'reschedule'; delayMs: number; reason: string };

export type JobHandler = (ctx: AppContext, payload: unknown) => Promise<HandlerResult>;

const done = (result?: string): HandlerResult => ({ type: 'done', ...(result ? { result } : {}) });

const WalletPayload = z.object({ walletId: z.uuid() });
const WebhookPayload = z.object({ notificationId: z.string() });
const WithdrawalPayload = z.object({ withdrawalId: z.uuid() });
const SweepPayload = z.object({ walletId: z.uuid(), token: z.string() });
const TreasuryInboundPayload = z.object({ treasuryInboundId: z.uuid() });

export const handlers: Record<JobKind, JobHandler> = {
  'wallet.create': async (ctx, payload) => done(await createDepositWallet(ctx, WalletPayload.parse(payload).walletId)),

  'webhook.process': async (ctx, payload) =>
    done(await processWebhookEvent(ctx, WebhookPayload.parse(payload).notificationId)),

  'withdrawal.submit': async (ctx, payload) => {
    const outcome = await submitWithdrawal(ctx, WithdrawalPayload.parse(payload).withdrawalId);
    return outcome.type === 'wait_liquidity'
      ? { type: 'reschedule', delayMs: 15_000, reason: 'awaiting treasury liquidity' }
      : done(outcome.result);
  },

  'sweep.schedule': async (ctx, payload) => {
    const { walletId, token } = SweepPayload.parse(payload);
    return done(await runSweep(ctx, walletId, token));
  },

  'treasury-inbound.classify': async (ctx, payload) => {
    const outcome = await classifyTreasuryInbound(ctx, TreasuryInboundPayload.parse(payload).treasuryInboundId);
    return outcome.type === 'wait' ? { type: 'reschedule', delayMs: outcome.delayMs, reason: outcome.reason } : done(outcome.result);
  },

  'reconcile.pending': async (ctx) => done(await reconcilePending(ctx)),
  'reconcile.inbound': async (ctx) => done(await reconcileInbound(ctx)),
  'reconcile.balances': async (ctx) => done(await reconcileBalances(ctx)),
};
