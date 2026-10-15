import type { ApiErrorCode } from '@circle-wallet/shared';

/**
 * Ожидаемая бизнес-ошибка с HTTP-статусом и машиночитаемым кодом.
 * Всё, что не AppError, обработчик ошибок превращает в 500 INTERNAL_ERROR без деталей наружу.
 */
export class AppError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly httpStatus: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what: string) => new AppError('NOT_FOUND', 404, `${what} не найден`);
