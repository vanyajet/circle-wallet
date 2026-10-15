/**
 * История операций пользователя: депозиты и выводы одной лентой, новые сверху.
 * Keyset-пагинация по (created_at, id): стабильна при вставке новых операций, в отличие от OFFSET.
 * Курсор содержит created_at в текстовом виде Postgres — с микросекундами (Date в JS их теряет).
 */
import { formatUnits, type OperationDto, type OperationsPageDto, type OperationStatus } from '@circle-wallet/shared';
import { sql } from 'kysely';
import { AppError } from '../lib/errors';
import type { AppContext } from './context';

interface OperationRow {
  type: 'DEPOSIT' | 'WITHDRAWAL';
  id: string;
  token: string;
  amount: string;
  status: OperationStatus;
  circle_state: string | null;
  tx_hash: string | null;
  counterparty: string | null;
  awaiting_liquidity: boolean;
  error_reason: string | null;
  error_details: string | null;
  created_at: Date;
  created_at_text: string;
  updated_at: Date;
  completed_at: Date | null;
}

export async function listOperations(
  ctx: AppContext,
  userId: string,
  limit: number,
  cursor: string | undefined,
): Promise<OperationsPageDto> {
  const after = cursor ? decodeCursor(cursor) : null;
  const rows = await sql<OperationRow>`
    select * from (
      select 'DEPOSIT' as type, id, token, amount::text as amount, status, circle_state, tx_hash,
             source_address as counterparty, false as awaiting_liquidity, error_reason, error_details,
             created_at, created_at::text as created_at_text, updated_at, completed_at
        from app.deposits where user_id = ${userId}
      union all
      select 'WITHDRAWAL' as type, id, token, amount::text as amount, status, circle_state, tx_hash,
             destination_address as counterparty, awaiting_liquidity, error_reason, error_details,
             created_at, created_at::text as created_at_text, updated_at, completed_at
        from app.withdrawals where user_id = ${userId}
    ) ops
    where ${after ? sql`(created_at, id) < (${after.createdAt}::timestamptz, ${after.id}::uuid)` : sql`true`}
    order by created_at desc, id desc
    limit ${limit + 1}`.execute(ctx.db);

  const page = rows.rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => toOperationDto(ctx, row)),
    nextCursor: rows.rows.length > limit && last ? encodeCursor(last.created_at_text, last.id) : null,
  };
}

function toOperationDto(ctx: AppContext, row: OperationRow): OperationDto {
  const decimals = ctx.tokens.bySymbol(row.token)?.decimals ?? 6;
  return {
    id: row.id,
    type: row.type,
    token: row.token,
    amount: formatUnits(BigInt(row.amount), decimals),
    status: row.status,
    circleState: row.circle_state,
    txHash: row.tx_hash,
    counterpartyAddress: row.counterparty,
    awaitingLiquidity: row.awaiting_liquidity,
    errorReason: row.error_reason,
    errorDetails: row.error_details,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

export function withdrawalToOperationDto(
  ctx: AppContext,
  w: {
    id: string;
    token: string;
    amount: string;
    status: OperationStatus;
    circle_state: string | null;
    tx_hash: string | null;
    destination_address: string;
    awaiting_liquidity: boolean;
    error_reason: string | null;
    error_details: string | null;
    created_at: Date;
    updated_at: Date;
    completed_at: Date | null;
  },
): OperationDto {
  return toOperationDto(ctx, {
    type: 'WITHDRAWAL',
    id: w.id,
    token: w.token,
    amount: w.amount,
    status: w.status,
    circle_state: w.circle_state,
    tx_hash: w.tx_hash,
    counterparty: w.destination_address,
    awaiting_liquidity: w.awaiting_liquidity,
    error_reason: w.error_reason,
    error_details: w.error_details,
    created_at: w.created_at,
    created_at_text: '',
    updated_at: w.updated_at,
    completed_at: w.completed_at,
  });
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id])).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [string, string];
    if (typeof createdAt !== 'string' || typeof id !== 'string') throw new Error('bad cursor');
    return { createdAt, id };
  } catch {
    throw new AppError('VALIDATION_ERROR', 400, 'Некорректный cursor');
  }
}
