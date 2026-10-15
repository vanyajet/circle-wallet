/**
 * Ошибки Circle API и их классификация.
 *
 * Для денег важна не сама ошибка, а ответ на вопрос «могли ли деньги уйти?».
 * Отсюда четыре класса:
 *  - UNKNOWN_OUTCOME — запрос мог дойти и выполниться (сеть, таймаут, 5xx, непонятный ответ).
 *    Повторяем с ТЕМ ЖЕ idempotencyKey: Circle вернёт уже созданную транзакцию, а не создаст новую.
 *  - RETRYABLE — Circle точно не выполнил запрос, но повтор может пройти (rate limit, очередь кошелька).
 *  - CONFIG — проблема на нашей стороне (ключ, entity secret). Пользователь не виноват: не проваливаем
 *    его вывод, а ретраим и громко логируем, пока оператор не починит конфигурацию.
 *  - DEFINITIVE — Circle отказал по существу запроса (невалидный адрес и т.п.). Повтор бессмыслен.
 */

export type CircleErrorKind = 'UNKNOWN_OUTCOME' | 'RETRYABLE' | 'CONFIG' | 'DEFINITIVE';

export class CircleApiError extends Error {
  constructor(
    message: string,
    readonly details: {
      /** HTTP-статус; undefined — ответа не было (сеть / таймаут). */
      status?: number;
      /** Числовой код Circle из тела ответа, если он был. */
      code?: number;
      method: string;
      path: string;
      /** Ответ пришёл, но не соответствует ожидаемой схеме (расхождение контракта или мок). */
      contractViolation?: boolean;
    },
  ) {
    super(message);
    this.name = 'CircleApiError';
  }

  get kind(): CircleErrorKind {
    return classifyCircleError(this);
  }
}

/**
 * Коды Circle, после которых повтор имеет смысл (см. docs/research/circle-api-notes.md):
 * 155505 — SCA ещё не поставил первую транзакцию в очередь; 155264 — очередь кошелька переполнена;
 * 155210 — «Retry the request»; 155202 — повтор после финализации; 156004 — переиспользован ciphertext
 * (у нас генерируется новый на каждый запрос, повтор исправит).
 */
const RETRYABLE_CODES = new Set([155505, 155264, 155210, 155202, 156004]);

/**
 * 156020 «Please use a new idempotency key»: Circle не принимает наш ключ, но неизвестно, был ли создан
 * перевод при первой попытке. Освобождать резерв нельзя — сначала ищем транзакцию по refId.
 */
const UNKNOWN_OUTCOME_CODES = new Set([156020]);

/** 156016 — entity secret не зарегистрирован; 156006 — TEST-ключ с mainnet и наоборот. */
const CONFIG_CODES = new Set([156016, 156006]);

export function classifyCircleError(error: CircleApiError): CircleErrorKind {
  const { status, code, contractViolation } = error.details;
  if (status === undefined || contractViolation) return 'UNKNOWN_OUTCOME';
  if (code !== undefined && UNKNOWN_OUTCOME_CODES.has(code)) return 'UNKNOWN_OUTCOME';
  if (status >= 500) return 'UNKNOWN_OUTCOME';
  if (status === 429) return 'RETRYABLE';
  if (code !== undefined && RETRYABLE_CODES.has(code)) return 'RETRYABLE';
  if (status === 401 || status === 403 || (code !== undefined && CONFIG_CODES.has(code))) return 'CONFIG';
  return 'DEFINITIVE';
}

export function isCircleError(error: unknown): error is CircleApiError {
  return error instanceof CircleApiError;
}

export function isNotFound(error: unknown): boolean {
  return isCircleError(error) && error.details.status === 404;
}
