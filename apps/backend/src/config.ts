/**
 * Конфигурация из переменных окружения, разбитая по секциям.
 *
 * Разным процессам нужны разные части: скриптам Circle не нужна БД, тестам не нужен Circle.
 * Поэтому каждая секция валидируется отдельно и только тогда, когда её запрашивают —
 * процесс падает на старте с понятной ошибкой, а не посреди обработки денег.
 */
import { z } from 'zod';

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const optionalUuid = z.preprocess(emptyToUndefined, z.uuid().optional());

const CircleSchema = z.object({
  // Завершающий "/" обрезаем: иначе получится "//v1/..." (так ломается и официальный SDK).
  CIRCLE_BASE_URL: z.url().transform((url) => url.replace(/\/+$/, '')),
  CIRCLE_API_KEY: z
    .string()
    .regex(/^(TEST|LIVE)_API_KEY:[^:]+:[^:]+$/, 'Ожидается формат TEST_API_KEY:<id>:<secret>'),
  CIRCLE_ENTITY_SECRET: z.string().regex(/^[0-9a-fA-F]{64}$/, 'Ожидается 64 hex-символа (32 байта)'),
  CIRCLE_BLOCKCHAIN: z.string().min(1).default('BASE-SEPOLIA'),
  CIRCLE_WALLET_SET_ID: optionalUuid,
  CIRCLE_TREASURY_WALLET_ID: optionalUuid,
  CIRCLE_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
});

const DatabaseSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(20).default(3),
  // auto: TLS для всех хостов, кроме localhost (Supabase требует TLS, локальный Postgres в тестах — нет).
  DATABASE_SSL: z.enum(['auto', 'require', 'disable']).default('auto'),
});

const ApiSchema = z.object({
  API_PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGIN: z.string().min(1).default('http://localhost:3000'),
});

const WorkerSchema = z.object({
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  // Порог sweep в единицах токена: мелочь не сметаем, чтобы не тратить газ (в проде — свой порог на токен).
  SWEEP_MIN_AMOUNT: z
    .string()
    .regex(/^(0|[1-9]\d*)(\.\d+)?$/, 'Десятичное число, например "1" или "0.5"')
    .default('1'),
});

const LogSchema = z.object({
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type CircleConfig = z.infer<typeof CircleSchema>;
export type DatabaseConfig = z.infer<typeof DatabaseSchema>;
export type ApiConfig = z.infer<typeof ApiSchema>;
export type WorkerConfig = z.infer<typeof WorkerSchema>;
export type LogConfig = z.infer<typeof LogSchema>;

export class ConfigError extends Error {
  constructor(section: string, issues: string[]) {
    super(`Некорректная конфигурация (${section}):\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

function parseSection<T extends z.ZodType>(section: string, schema: T, env: NodeJS.ProcessEnv): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    // В сообщение попадают только имена переменных и описание проблемы — не значения (там секреты).
    throw new ConfigError(
      section,
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return result.data;
}

export const loadCircleConfig = (env = process.env): CircleConfig => parseSection('circle', CircleSchema, env);
export const loadDatabaseConfig = (env = process.env): DatabaseConfig =>
  parseSection('database', DatabaseSchema, env);
export const loadApiConfig = (env = process.env): ApiConfig => parseSection('api', ApiSchema, env);
export const loadWorkerConfig = (env = process.env): WorkerConfig => parseSection('worker', WorkerSchema, env);
export const loadLogConfig = (env = process.env): LogConfig => parseSection('log', LogSchema, env);

/** Схемы наружу — для скрипта env:check (проверяет наличие переменных, не печатая значений). */
export const configSections = {
  circle: CircleSchema,
  database: DatabaseSchema,
  api: ApiSchema,
  worker: WorkerSchema,
  log: LogSchema,
} as const;
