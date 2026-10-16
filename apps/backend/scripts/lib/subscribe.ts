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
    // Удаляем только наши прошлые quick tunnel'ы — чужие подписки на том же аккаунте (другие окружения) не трогаем.
    if (sub.endpoint !== endpoint && sub.endpoint.endsWith(`.trycloudflare.com${WEBHOOK_PATH}`)) {
      await circle.deleteSubscription(sub.id);
      console.log(`Удалена устаревшая подписка ${sub.id} → ${sub.endpoint}`);
    }
  }

  const current = existing.find((sub) => sub.endpoint === endpoint);
  if (current) {
    console.log(`Подписка уже существует: ${current.id} → ${endpoint}`);
    return;
  }
  // Circle проверяет endpoint HEAD-запросом. Если api в этот момент перезапускается (watch-режим после правки кода)
  // или туннель ещё «прогревается», проверка падает с 5xx — повторяем несколько раз, а не сдаёмся сразу.
  for (let attempt = 1; ; attempt++) {
    try {
      const created = await circle.createSubscription({ endpoint, notificationTypes: NOTIFICATION_TYPES });
      console.log(`Создана подписка ${created.id} → ${endpoint} (${NOTIFICATION_TYPES.join(', ')})`);
      return;
    } catch (error) {
      const verificationFailed = error instanceof Error && error.message.includes('Failed to verify endpoint');
      if (!verificationFailed || attempt >= 6) throw error;
      console.log(`Circle не смог проверить endpoint (попытка ${attempt}), повтор через 5 с...`);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}
