import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import pg from 'pg';
import type { DatabaseConfig } from '../config';
import type { Database } from './schema';

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;
/** Любой исполнитель запросов: и пул, и открытая транзакция. */
export type DbExecutor = Db | Tx;

/**
 * TLS для Supabase обязателен. rejectUnauthorized=false — осознанное упрощение для тестового задания:
 * в проде нужно закрепить CA Supabase (Dashboard → Database → SSL certificate) и проверять сертификат.
 */
export function pgConnectionOptions(config: DatabaseConfig): pg.ClientConfig {
  const host = safeHostname(config.DATABASE_URL);
  const useSsl =
    config.DATABASE_SSL === 'require' ||
    (config.DATABASE_SSL === 'auto' && host !== 'localhost' && host !== '127.0.0.1');
  return {
    connectionString: config.DATABASE_URL,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
    keepAlive: true,
    // Время ожидания соединения: при недоступной БД лучше быстро ответить 503, чем висеть.
    connectionTimeoutMillis: 10_000,
  };
}

export function createDb(config: DatabaseConfig): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({
    ...pgConnectionOptions(config),
    // Session pooler Supabase держит отдельное серверное соединение на каждое клиентское — пул небольшой (ADR-0004).
    max: config.DB_POOL_MAX,
    idleTimeoutMillis: 30_000,
  });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return { db, pool };
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
