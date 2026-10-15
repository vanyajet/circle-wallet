/**
 * Процесс api: REST для фронтенда, приём вебхуков Circle, SSE.
 * Мутирующих вызовов Circle здесь нет — их делает worker (ADR-0005).
 */
import { createAppContext, retryUntilSuccess } from '../bootstrap';
import { WebhookSignatureVerifier } from '../circle/webhook-signature';
import { loadApiConfig } from '../config';
import { pgConnectionOptions } from '../db/client';
import { ensureTreasuryWallet } from '../domain/wallets';
import { createHttpApp } from '../http/app';
import { createLogger } from '../lib/logger';
import { PgListener } from '../realtime/pg-listener';
import { SseHub } from '../realtime/sse-hub';

const logger = createLogger('api');
const apiConfig = loadApiConfig();
const { ctx, circle, pool, dbConfig } = await createAppContext(logger);

// Treasury нужен api для запрета выводов на адрес treasury и для /ops.
await retryUntilSuccess(logger, 'treasury registration', () => ensureTreasuryWallet(ctx));

const sse = new SseHub(logger.child({ component: 'sse' }));
const listener = new PgListener({
  connection: pgConnectionOptions(dbConfig),
  channels: ['app_events'],
  logger: logger.child({ component: 'listener' }),
  onNotification: (_channel, payload) => {
    try {
      const parsed = JSON.parse(payload ?? '{}') as { userId?: string | null };
      sse.publishInvalidate({ userId: parsed.userId ?? null });
    } catch {
      sse.publishResync();
    }
  },
  onReconnect: () => sse.publishResync(),
});
await listener.start();

const app = createHttpApp(ctx, { sse, verifier: new WebhookSignatureVerifier(circle), corsOrigin: apiConfig.CORS_ORIGIN });
const server = app.listen(apiConfig.API_PORT, () => {
  logger.info({ port: apiConfig.API_PORT }, 'api listening');
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down api');
  // SSE-соединения бесконечные — закрываем их сами, иначе server.close() не завершится.
  sse.close();
  server.close();
  await listener.stop();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
