import type { ApiErrorCode, ApiErrorDto } from '@circle-wallet/shared';

/** Базовый URL API. Браузер ходит в API напрямую (CORS), без прокси Next: SSE должен подключаться напрямую. */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000').replace(/\/+$/, '');

const UNAVAILABLE_MESSAGE = 'Сервер недоступен';

/** Коды ошибок клиента в дополнение к кодам API: сеть недоступна или ответ не в формате ApiErrorDto. */
export type ClientErrorCode = ApiErrorCode | 'NETWORK_ERROR' | 'BAD_RESPONSE';

export class ApiError extends Error {
  constructor(
    /** HTTP-статус; 0 — запрос не дошёл до сервера или ответ не получен. */
    readonly status: number,
    readonly code: ClientErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /**
   * Исход запроса неизвестен: сеть, 5xx или нечитаемый 2xx. Мутация могла как выполниться, так и нет —
   * повтор должен идти с тем же Idempotency-Key. 4xx — однозначный отказ.
   */
  get isUnknownOutcome(): boolean {
    return this.status === 0 || this.status >= 500 || this.status < 300;
  }
}

function isApiErrorDto(value: unknown): value is ApiErrorDto {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const error = (value as { error: unknown }).error;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}

export function apiUrl(path: string): string {
  return `${API_URL}${path}`;
}

/**
 * Типизированный fetch к нашему API: JSON в обе стороны, не-2xx → ApiError.
 * Content-Type ставим только при наличии тела, чтобы GET оставался «простым» запросом без CORS preflight.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(apiUrl(path), { ...init, headers });
  } catch (error) {
    // Отмену запроса (React Query) пробрасываем как есть, остальное — недоступность сети/сервера.
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'NETWORK_ERROR', UNAVAILABLE_MESSAGE);
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    // Соединение оборвалось на чтении тела: исход неизвестен, как и при сетевой ошибке.
    throw new ApiError(0, 'NETWORK_ERROR', UNAVAILABLE_MESSAGE);
  }

  let body: unknown;
  let parsed = true;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = false;
  }

  if (!response.ok) {
    if (isApiErrorDto(body)) {
      throw new ApiError(response.status, body.error.code, body.error.message, body.error.details);
    }
    throw new ApiError(response.status, 'BAD_RESPONSE', UNAVAILABLE_MESSAGE);
  }
  if (!parsed) {
    throw new ApiError(response.status, 'BAD_RESPONSE', 'Некорректный ответ сервера');
  }
  return body as T;
}
