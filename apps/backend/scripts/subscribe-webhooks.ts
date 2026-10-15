/**
 * Подписка Circle на вебхуки по публичному адресу api.
 *
 *   pnpm circle:subscribe https://<random>.trycloudflare.com
 *   (или без аргумента — возьмёт PUBLIC_API_URL из .env)
 *
 * Обычно вызывать вручную не нужно: `pnpm tunnel` поднимает cloudflared и подписывается сам.
 */
import { createCircleClient } from '../src/circle';
import { createLogger } from '../src/lib/logger';
import { subscribeWebhooks } from './lib/subscribe';

const publicUrl = process.argv[2] ?? process.env.PUBLIC_API_URL;
if (!publicUrl) {
  console.error('Укажите публичный URL: pnpm circle:subscribe https://<host> (или PUBLIC_API_URL в .env)');
  process.exit(1);
}

await subscribeWebhooks(createCircleClient(createLogger('subscribe')), publicUrl);
