/**
 * Настоящий Postgres 17 в Docker (testcontainers) с нашими миграциями из supabase/migrations.
 * Инварианты леджера живут в БД (триггеры, constraints) — их нельзя честно проверить на моке БД.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { createDb, type Db } from '../../src/db/client';
import type { AppContext } from '../../src/domain/context';
import { TokenRegistry } from '../../src/domain/tokens';
import { createLogger } from '../../src/lib/logger';
import { FakeCircleGateway } from './fake-circle';

const migrationsDir = fileURLToPath(new URL('../../../../supabase/migrations/', import.meta.url));

export interface TestEnv {
  container: StartedPostgreSqlContainer;
  db: Db;
  pool: pg.Pool;
  circle: FakeCircleGateway;
  ctx: AppContext;
  stop: () => Promise<void>;
}

export async function startTestEnv(): Promise<TestEnv> {
  const container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const url = container.getConnectionUri();

  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    await admin.query(readFileSync(`${migrationsDir}${file}`, 'utf8'));
  }
  await admin.end();

  const { db, pool } = createDb({ DATABASE_URL: url, DB_POOL_MAX: 10, DATABASE_SSL: 'disable' });
  const circle = new FakeCircleGateway();
  const ctx: AppContext = {
    db,
    circle,
    tokens: await TokenRegistry.load(db),
    logger: createLogger('test'),
    settings: {
      blockchain: 'BASE-SEPOLIA',
      walletSetId: '00000000-0000-4000-8000-000000000000',
      treasuryCircleWalletId: 'treasury-circle-id',
      sweepMinAmount: '1',
    },
  };
  circle.registerWallet({
    id: 'treasury-circle-id',
    address: '0x00000000000000000000000000000000000000aa',
    blockchain: 'BASE-SEPOLIA',
    state: 'LIVE',
  });

  return {
    container,
    db,
    pool,
    circle,
    ctx,
    stop: async () => {
      await db.destroy();
      await container.stop();
    },
  };
}

export const USDC_TOKEN_ID = 'bdf128b4-827b-5267-8f9e-243694989b5f';
