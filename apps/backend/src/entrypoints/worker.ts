/**
 * Процесс worker: выполняет задачи из очереди app.jobs (ADR-0005).
 * Можно запускать в нескольких экземплярах: координация — через SKIP LOCKED и lease в Postgres.
 */
import { createAppContext, retryUntilSuccess } from '../bootstrap';
import { pgConnectionOptions } from '../db/client';
import { ensureTreasuryWallet } from '../domain/wallets';
import { handlers } from '../jobs/handlers';
import { JobWorker } from '../jobs/worker';
import { createLogger } from '../lib/logger';
import { PgListener } from '../realtime/pg-listener';

const logger = createLogger('worker');
const { ctx, pool, dbConfig, workerConfig } = await createAppContext(logger);

await retryUntilSuccess(logger, 'treasury registration', () => ensureTreasuryWallet(ctx));

const worker = new JobWorker(ctx, handlers, { concurrency: workerConfig.WORKER_CONCURRENCY });
const listener = new PgListener({
  connection: pgConnectionOptions(dbConfig),
  channels: ['app_jobs'],
  logger: logger.child({ component: 'listener' }),
  onNotification: () => worker.notify(),
  onReconnect: () => worker.notify(),
});

await listener.start();
worker.start();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down worker');
  await worker.stop();
  await listener.stop();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
