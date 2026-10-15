/**
 * REST API для фронтенда. Контракт — packages/shared/src/api.ts.
 */
import {
  CreateUserRequestSchema,
  CreateWithdrawalRequestSchema,
  IDEMPOTENCY_KEY_HEADER,
  OperationsQuerySchema,
  type TokensListDto,
  type UsersListDto,
} from '@circle-wallet/shared';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import type { AppContext } from '../../domain/context';
import { listOperations, withdrawalToOperationDto } from '../../domain/operations';
import { getOpsOverview } from '../../domain/ops';
import { assertUserExists, createUser, getUserDetails, listUsers } from '../../domain/users';
import { createWithdrawal } from '../../domain/withdrawals';
import { AppError } from '../../lib/errors';
import type { SseHub } from '../../realtime/sse-hub';

const UserIdParam = z.uuid();

/** Express 5 сам пробрасывает отклонённые промисы в error handler; обёртка оставлена для явности типов. */
type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
const handle = (fn: AsyncHandler) => fn;

function parseUserId(req: Request): string {
  const parsed = UserIdParam.safeParse(req.params.id);
  // Невалидный UUID — это «не найден», а не 500 от Postgres.
  if (!parsed.success) throw new AppError('NOT_FOUND', 404, 'Пользователь не найден');
  return parsed.data;
}

export function apiRouter(ctx: AppContext, sse: SseHub): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get(
    '/ready',
    handle(async (_req, res) => {
      await sql`select 1`.execute(ctx.db);
      res.json({ status: 'ready', sseClients: sse.size });
    }),
  );

  router.get('/tokens', (_req, res) => {
    const body: TokensListDto = {
      items: ctx.tokens.all().map((t) => ({
        symbol: t.symbol,
        decimals: t.decimals,
        blockchain: t.blockchain,
        contractAddress: t.contract_address,
      })),
    };
    res.json(body);
  });

  router.get(
    '/users',
    handle(async (_req, res) => {
      const body: UsersListDto = { items: await listUsers(ctx) };
      res.json(body);
    }),
  );

  router.post(
    '/users',
    handle(async (req, res) => {
      const { name } = CreateUserRequestSchema.parse(req.body);
      res.status(201).json(await createUser(ctx, name));
    }),
  );

  router.get(
    '/users/:id',
    handle(async (req, res) => {
      res.json(await getUserDetails(ctx, parseUserId(req)));
    }),
  );

  router.get(
    '/users/:id/operations',
    handle(async (req, res) => {
      const userId = parseUserId(req);
      const query = OperationsQuerySchema.parse(req.query);
      await assertUserExists(ctx, userId);
      res.json(await listOperations(ctx, userId, query.limit, query.cursor));
    }),
  );

  router.post(
    '/users/:id/withdrawals',
    handle(async (req, res) => {
      const userId = parseUserId(req);
      const body = CreateWithdrawalRequestSchema.parse(req.body);
      const { withdrawal, replayed } = await createWithdrawal(ctx, userId, req.header(IDEMPOTENCY_KEY_HEADER), body);
      // 202: вывод принят в обработку; повтор с тем же ключом возвращает тот же вывод (200).
      res.status(replayed ? 200 : 202).json(withdrawalToOperationDto(ctx, withdrawal));
    }),
  );

  router.get(
    '/users/:id/events',
    handle(async (req, res) => {
      const userId = parseUserId(req);
      await assertUserExists(ctx, userId);
      sse.subscribe(req, res, userId);
    }),
  );

  router.get('/events', (req, res) => {
    sse.subscribe(req, res, null);
  });

  router.get(
    '/ops/overview',
    handle(async (_req, res) => {
      res.json(await getOpsOverview(ctx));
    }),
  );

  return router;
}
