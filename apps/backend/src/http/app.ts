import type { ApiErrorDto } from '@circle-wallet/shared';
import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
import { ZodError } from 'zod';
import type { WebhookSignatureVerifier } from '../circle/webhook-signature';
import type { AppContext } from '../domain/context';
import { AppError } from '../lib/errors';
import type { SseHub } from '../realtime/sse-hub';
import { apiRouter } from './routes/api';
import { webhooksRouter } from './routes/webhooks';

export function createHttpApp(ctx: AppContext, deps: { sse: SseHub; verifier: WebhookSignatureVerifier; corsOrigin: string }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(
    pinoHttp({
      logger: ctx.logger.child({ component: 'http' }),
      // SSE-соединения долгие, health — шумные: не логируем их как обычные запросы.
      autoLogging: { ignore: (req) => /\/events$|\/health$/.test(req.url ?? '') },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    }),
  );

  // Вебхуки — ДО express.json(): им нужно сырое тело для проверки подписи. CORS им не нужен (server-to-server).
  app.use(webhooksRouter(ctx, deps.verifier));

  app.use(cors({ origin: deps.corsOrigin.split(',').map((o) => o.trim()), exposedHeaders: ['Idempotency-Key'] }));
  app.use(express.json({ limit: '100kb' }));
  app.use(apiRouter(ctx, deps.sse));

  app.use((_req, res) => {
    const body: ApiErrorDto = { error: { code: 'NOT_FOUND', message: 'Маршрут не найден' } };
    res.status(404).json(body);
  });

  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    let status = 500;
    let body: ApiErrorDto = { error: { code: 'INTERNAL_ERROR', message: 'Внутренняя ошибка сервера' } };

    if (err instanceof AppError) {
      status = err.httpStatus;
      body = { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } };
    } else if (err instanceof ZodError) {
      status = 400;
      body = {
        error: {
          code: 'VALIDATION_ERROR',
          message: err.issues[0]?.message ?? 'Некорректный запрос',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      };
    } else if (err?.type === 'entity.parse.failed') {
      status = 400;
      body = { error: { code: 'VALIDATION_ERROR', message: 'Некорректный JSON' } };
    } else if (isDbUnavailable(err)) {
      status = 503;
      body = { error: { code: 'SERVICE_UNAVAILABLE', message: 'База данных временно недоступна' } };
    }

    if (status >= 500) req.log.error({ err }, 'request failed');
    if (res.headersSent) return;
    res.status(status).json(body);
  };
  app.use(errorHandler);

  return app;
}

function isDbUnavailable(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === '57P01' || code === '53300' || code === 'ENOTFOUND';
}
