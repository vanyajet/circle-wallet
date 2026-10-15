/**
 * Вебхуки Circle: приём в inbox (api) и обработка (worker) — ADR-0006.
 */
import { normalizeNotificationTransaction } from '../circle/client';
import { CircleTransactionNotificationSchema, type NotificationEnvelope } from '../circle/schemas';
import { enqueueJob } from '../jobs/queue';
import { applyCircleTransaction } from './circle-events';
import type { AppContext } from './context';

const TRANSACTION_TYPES = new Set(['transactions.inbound', 'transactions.outbound']);

/**
 * Сохранить событие в inbox и поставить задачу на обработку — в одной транзакции.
 * Повторная доставка того же notificationId ничего не делает (dedupe по PK).
 */
export async function ingestWebhook(ctx: Pick<AppContext, 'db'>, envelope: NotificationEnvelope): Promise<'STORED' | 'DUPLICATE'> {
  return ctx.db.transaction().execute(async (trx) => {
    const inserted = await trx
      .insertInto('app.webhook_events')
      .values({
        notification_id: envelope.notificationId,
        notification_type: envelope.notificationType,
        subscription_id: envelope.subscriptionId,
        payload: JSON.stringify(envelope),
      })
      .onConflict((oc) => oc.column('notification_id').doNothing())
      .returning('notification_id')
      .executeTakeFirst();
    if (!inserted) return 'DUPLICATE';
    await enqueueJob(trx, 'webhook.process', { notificationId: envelope.notificationId }, { dedupeKey: `webhook:${envelope.notificationId}` });
    return 'STORED';
  });
}

/** Задача webhook.process. RetryLaterError пробрасывается наружу — очередь повторит позже. */
export async function processWebhookEvent(ctx: AppContext, notificationId: string): Promise<string> {
  const event = await ctx.db
    .selectFrom('app.webhook_events')
    .selectAll()
    .where('notification_id', '=', notificationId)
    .executeTakeFirst();
  if (!event) return 'IGNORED:not_found';
  if (event.processed_at) return `NOOP:${event.result ?? 'processed'}`;

  let result: string;
  if (TRANSACTION_TYPES.has(event.notification_type)) {
    const envelope = event.payload as NotificationEnvelope;
    const parsed = CircleTransactionNotificationSchema.safeParse(envelope.notification);
    if (!parsed.success) {
      ctx.logger.error({ notificationId, issues: parsed.error.issues }, 'webhook: unexpected transaction payload');
      result = 'IGNORED:invalid_payload';
    } else {
      result = await applyCircleTransaction(ctx, normalizeNotificationTransaction(parsed.data), 'webhook');
    }
  } else {
    result = `IGNORED:unsupported_type:${event.notification_type}`;
  }

  await ctx.db
    .updateTable('app.webhook_events')
    .set({ processed_at: new Date(), result })
    .where('notification_id', '=', notificationId)
    .execute();
  return result;
}
