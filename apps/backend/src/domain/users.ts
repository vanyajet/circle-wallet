import { formatUnits, type BalanceDto, type UserDetailsDto, type UserSummaryDto } from '@circle-wallet/shared';
import { notFound } from '../lib/errors';
import { enqueueJob } from '../jobs/queue';
import type { AppContext } from './context';

/**
 * Создание пользователя. Кошелёк в Circle создаётся асинхронно (задача wallet.create):
 * пользователь, строка кошелька в статусе PENDING и задача появляются в ОДНОЙ транзакции (outbox),
 * поэтому не бывает «пользователя без адреса навсегда», даже если Circle сейчас недоступен.
 */
export async function createUser(ctx: AppContext, name: string): Promise<UserSummaryDto> {
  return ctx.db.transaction().execute(async (trx) => {
    const user = await trx.insertInto('app.users').values({ name }).returningAll().executeTakeFirstOrThrow();
    const wallet = await trx
      .insertInto('app.wallets')
      .values({ kind: 'DEPOSIT', user_id: user.id, blockchain: ctx.settings.blockchain })
      .returning(['id', 'status', 'address'])
      .executeTakeFirstOrThrow();
    await enqueueJob(trx, 'wallet.create', { walletId: wallet.id }, { dedupeKey: `wallet:${wallet.id}` });
    return {
      id: user.id,
      name: user.name,
      createdAt: user.created_at.toISOString(),
      depositAddress: wallet.address,
      walletStatus: wallet.status,
    };
  });
}

export async function listUsers(ctx: AppContext): Promise<UserSummaryDto[]> {
  const rows = await ctx.db
    .selectFrom('app.users as u')
    .leftJoin('app.wallets as w', (join) => join.onRef('w.user_id', '=', 'u.id').on('w.kind', '=', 'DEPOSIT'))
    .select(['u.id', 'u.name', 'u.created_at', 'w.address', 'w.status'])
    .orderBy('u.created_at', 'desc')
    .orderBy('u.id', 'desc')
    .limit(500)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at.toISOString(),
    depositAddress: r.address,
    walletStatus: r.status ?? 'PENDING',
  }));
}

export async function getUserDetails(ctx: AppContext, userId: string): Promise<UserDetailsDto> {
  const row = await ctx.db
    .selectFrom('app.users as u')
    .leftJoin('app.wallets as w', (join) => join.onRef('w.user_id', '=', 'u.id').on('w.kind', '=', 'DEPOSIT'))
    .select(['u.id', 'u.name', 'u.created_at', 'w.address', 'w.status', 'w.blockchain'])
    .where('u.id', '=', userId)
    .executeTakeFirst();
  if (!row) throw notFound('Пользователь');

  const accounts = await ctx.db
    .selectFrom('app.ledger_accounts')
    .select(['type', 'token', 'balance'])
    .where('user_id', '=', userId)
    .execute();

  // Балансы по всем поддерживаемым токенам, даже если счёт ещё не создан (нули).
  const balances: BalanceDto[] = ctx.tokens.all().map((token) => {
    const find = (type: 'USER_AVAILABLE' | 'USER_HELD') =>
      BigInt(accounts.find((a) => a.type === type && a.token === token.symbol)?.balance ?? '0');
    return {
      token: token.symbol,
      decimals: token.decimals,
      available: formatUnits(find('USER_AVAILABLE'), token.decimals),
      held: formatUnits(find('USER_HELD'), token.decimals),
    };
  });

  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at.toISOString(),
    depositAddress: row.address,
    walletStatus: row.status ?? 'PENDING',
    blockchain: row.blockchain ?? ctx.settings.blockchain,
    balances,
  };
}

export async function assertUserExists(ctx: AppContext, userId: string): Promise<void> {
  const user = await ctx.db.selectFrom('app.users').select('id').where('id', '=', userId).executeTakeFirst();
  if (!user) throw notFound('Пользователь');
}
