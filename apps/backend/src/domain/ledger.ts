/**
 * Проводки в double-entry ledger (ADR-0003).
 *
 * Код приложения лишь формирует проводку; гарантии даёт база:
 *  - сбалансированность (Σ debit = Σ credit) — deferred trigger на commit;
 *  - exactly-once — UNIQUE (kind, reference_id): повторное событие возвращает ALREADY_POSTED;
 *  - неотрицательность балансов — CHECK на ledger_accounts (кешированный баланс обновляет триггер).
 */
import { sql } from 'kysely';
import type { DbExecutor, Tx } from '../db/client';
import type { AccountType, Direction, LedgerKind } from '../db/schema';

export interface AccountRef {
  type: AccountType;
  token: string;
  userId?: string | null;
  walletId?: string | null;
}

export interface PostingLine {
  account: AccountRef;
  direction: Direction;
  amount: bigint;
}

export const userAvailable = (userId: string, token: string): AccountRef => ({ type: 'USER_AVAILABLE', token, userId });
export const userHeld = (userId: string, token: string): AccountRef => ({ type: 'USER_HELD', token, userId });
export const custody = (walletId: string, token: string): AccountRef => ({ type: 'CUSTODY', token, walletId });
export const house = (token: string): AccountRef => ({ type: 'HOUSE', token });

/** Найти счёт или создать с нулевым балансом (счета создаются лениво, при первой проводке). */
export async function ensureAccount(trx: DbExecutor, ref: AccountRef): Promise<string> {
  await trx
    .insertInto('app.ledger_accounts')
    .values({ type: ref.type, token: ref.token, user_id: ref.userId ?? null, wallet_id: ref.walletId ?? null })
    .onConflict((oc) => oc.constraint('ledger_accounts_unique').doNothing())
    .execute();
  const row = await findAccountQuery(trx, ref).select('id').executeTakeFirstOrThrow();
  return row.id;
}

/**
 * Заблокировать счёт (SELECT … FOR UPDATE) и вернуть баланс.
 * Используется для решений «хватает ли средств»: блокировка сериализует конкурирующие транзакции,
 * так что два параллельных вывода не увидят один и тот же баланс.
 */
export async function lockAccount(trx: Tx, ref: AccountRef): Promise<{ id: string; balance: bigint }> {
  await ensureAccount(trx, ref);
  const row = await findAccountQuery(trx, ref).select(['id', 'balance']).forUpdate().executeTakeFirstOrThrow();
  return { id: row.id, balance: BigInt(row.balance) };
}

export async function getAccountBalance(db: DbExecutor, ref: AccountRef): Promise<bigint> {
  const row = await findAccountQuery(db, ref).select('balance').executeTakeFirst();
  return row ? BigInt(row.balance) : 0n;
}

export type PostResult = 'POSTED' | 'ALREADY_POSTED';

export async function postLedgerTransaction(
  trx: Tx,
  input: { kind: LedgerKind; referenceId: string; description?: string; lines: PostingLine[] },
): Promise<PostResult> {
  const inserted = await trx
    .insertInto('app.ledger_transactions')
    .values({ kind: input.kind, reference_id: input.referenceId, description: input.description ?? null })
    .onConflict((oc) => oc.constraint('ledger_transactions_exactly_once').doNothing())
    .returning('id')
    .executeTakeFirst();
  if (!inserted) return 'ALREADY_POSTED';

  // Последовательно: все запросы идут через одно соединение транзакции.
  const resolved: Array<PostingLine & { accountId: string }> = [];
  for (const line of input.lines) {
    if (line.amount <= 0n) throw new Error(`Ledger amount must be positive, got ${line.amount}`);
    resolved.push({ ...line, accountId: await ensureAccount(trx, line.account) });
  }
  // Записи вставляются в порядке account_id: триггер обновляет (и блокирует) строки счетов в этом же порядке,
  // поэтому две параллельные проводки по одним и тем же счетам не поймают deadlock.
  resolved.sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));

  await trx
    .insertInto('app.ledger_entries')
    .values(
      resolved.map((line) => ({
        transaction_id: inserted.id,
        account_id: line.accountId,
        direction: line.direction,
        amount: line.amount.toString(),
      })),
    )
    .execute();
  return 'POSTED';
}

function findAccountQuery(db: DbExecutor, ref: AccountRef) {
  return db
    .selectFrom('app.ledger_accounts')
    .where('type', '=', ref.type)
    .where('token', '=', ref.token)
    .where(sql<boolean>`user_id is not distinct from ${ref.userId ?? null}::uuid`)
    .where(sql<boolean>`wallet_id is not distinct from ${ref.walletId ?? null}::uuid`);
}
