import type { CircleClient } from '../../src/circle';

export const WEBHOOK_PATH = '/webhooks/circle';
const NOTIFICATION_TYPES = ['transactions.inbound', 'transactions.outbound'];

/**
 * Создаёт подписку Circle на {publicUrl}/webhooks/circle и удаляет наши старые подписки
 * (с тем же путём, но другим хостом — например, прошлый адрес quick tunnel, который меняется при перезапуске).
 * При создании Circle делает HEAD на endpoint, поэтому api должен быть запущен и доступен по publicUrl.
 */
export async function subscribeWebhooks(circle: CircleClient, publicUrl: string): Promise<void> {
  const endpoint = `${publicUrl.replace(/\/+$/, '')}${WEBHOOK_PATH}`;
  const existing = await circle.listSubscriptions();

  for (const sub of existing) {
    if (sub.endpoint !== endpoint && sub.endpoint.endsWith(WEBHOOK_PATH)) {
      await circle.deleteSubscription(sub.id);
      console.log(`Удалена устаревшая подписка ${sub.id} → ${sub.endpoint}`);
    }
  }

  const current = existing.find((sub) => sub.endpoint === endpoint);
  if (current) {
    console.log(`Подписка уже существует: ${current.id} → ${endpoint}`);
    return;
  }
  const created = await circle.createSubscription({ endpoint, notificationTypes: NOTIFICATION_TYPES });
  console.log(`Создана подписка ${created.id} → ${endpoint} (${NOTIFICATION_TYPES.join(', ')})`);
}
