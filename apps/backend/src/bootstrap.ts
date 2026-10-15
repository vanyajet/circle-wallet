/**
 * Сборка зависимостей (composition root), общая для api и worker.
 */
import { createCircleClient } from './circle';
import { loadCircleConfig, loadDatabaseConfig, loadWorkerConfig } from './config';
import { createDb } from './db/client';
import type { AppContext } from './domain/context';
import { TokenRegistry } from './domain/tokens';
import type { Logger } from './lib/logger';

export async function createAppContext(logger: Logger) {
  const circleConfig = loadCircleConfig();
  const dbConfig = loadDatabaseConfig();
  const workerConfig = loadWorkerConfig();
  const { db, pool } = createDb(dbConfig);
  const circle = createCircleClient(logger.child({ component: 'circle' }), circleConfig);
  const tokens = await TokenRegistry.load(db);

  const ctx: AppContext = {
    db,
    circle,
    tokens,
    logger,
    settings: {
      blockchain: circleConfig.CIRCLE_BLOCKCHAIN,
      walletSetId: circleConfig.CIRCLE_WALLET_SET_ID,
      treasuryCircleWalletId: circleConfig.CIRCLE_TREASURY_WALLET_ID,
      sweepMinAmount: workerConfig.SWEEP_MIN_AMOUNT,
    },
  };
  return { ctx, circle, pool, dbConfig, workerConfig };
}

/** Повторять операцию старта, пока не получится (например, БД или Circle временно недоступны). */
export async function retryUntilSuccess<T>(logger: Logger, what: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const delay = Math.min(30_000, 1_000 * 2 ** attempt);
      logger.warn({ err, attempt, retryInMs: delay }, `${what} failed, retrying`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
