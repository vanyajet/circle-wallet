/** Коды ошибок Postgres, на которые мы реагируем осмысленно. */
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

interface PgError {
  code?: string;
  constraint?: string;
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = error as PgError;
  return e?.code === UNIQUE_VIOLATION && (constraint === undefined || e.constraint === constraint);
}

export function isCheckViolation(error: unknown, constraint?: string): boolean {
  const e = error as PgError;
  return e?.code === CHECK_VIOLATION && (constraint === undefined || e.constraint === constraint);
}
