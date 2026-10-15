/**
 * Кошельки: создание deposit-кошелька пользователя в Circle и регистрация treasury в БД.
 */
import { CircleApiError } from '../circle/errors';
import type { DbExecutor } from '../db/client';
import type { Wallet } from '../db/schema';
import type { AppContext } from './context';

/**
 * Задача wallet.create: создать SCA-кошелёк в Circle для строки wallets в статусе PENDING.
 * idempotencyKey хранится в строке с момента её создания — повтор после сбоя вернёт тот же кошелёк,
 * а не создаст второй.
 */
export async function createDepositWallet(ctx: AppContext, walletId: string): Promise<'CREATED' | 'ALREADY_ACTIVE'> {
  const wallet = await ctx.db.selectFrom('app.wallets').selectAll().where('id', '=', walletId).executeTakeFirstOrThrow();
  if (wallet.status === 'ACTIVE') return 'ALREADY_ACTIVE';
  if (!ctx.settings.walletSetId) {
    // Ошибка конфигурации, а не пользователя: задача будет ретраиться, пока оператор не выполнит bootstrap.
    throw new CircleApiError('CIRCLE_WALLET_SET_ID не задан — выполните pnpm circle:bootstrap', {
      method: 'POST',
      path: '/v1/w3s/developer/wallets',
      status: 401,
    });
  }

  const created = await ctx.circle.createWallet({
    idempotencyKey: wallet.circle_idempotency_key,
    walletSetId: ctx.settings.walletSetId,
    blockchain: wallet.blockchain,
    name: `deposit:${wallet.user_id}`,
    refId: wallet.user_id!,
  });

  await ctx.db
    .updateTable('app.wallets')
    .set({ status: 'ACTIVE', circle_wallet_id: created.id, address: created.address.toLowerCase() })
    .where('id', '=', walletId)
    .where('status', '=', 'PENDING')
    .execute();
  ctx.logger.info({ walletId, circleWalletId: created.id, address: created.address }, 'deposit wallet created');
  return 'CREATED';
}

/**
 * Treasury создаётся скриптом bootstrap в Circle, а здесь регистрируется в БД (идемпотентно).
 * Вызывается на старте api и worker: после пересоздания БД строка восстановится сама.
 */
export async function ensureTreasuryWallet(ctx: AppContext): Promise<Wallet | null> {
  const circleWalletId = ctx.settings.treasuryCircleWalletId;
  const existing = await getTreasuryWallet(ctx.db);
  if (existing) {
    if (circleWalletId && existing.circle_wallet_id !== circleWalletId) {
      throw new Error(
        `В БД зарегистрирован другой treasury (${existing.circle_wallet_id}), чем в CIRCLE_TREASURY_WALLET_ID (${circleWalletId})`,
      );
    }
    return existing;
  }
  if (!circleWalletId) {
    ctx.logger.warn('CIRCLE_TREASURY_WALLET_ID не задан — выводы и sweep недоступны до pnpm circle:bootstrap');
    return null;
  }

  const info = await ctx.circle.getWallet(circleWalletId);
  await ctx.db
    .insertInto('app.wallets')
    .values({
      kind: 'TREASURY',
      status: 'ACTIVE',
      blockchain: info.blockchain,
      circle_wallet_id: info.id,
      address: info.address.toLowerCase(),
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
  ctx.logger.info({ circleWalletId: info.id, address: info.address }, 'treasury wallet registered');
  return getTreasuryWallet(ctx.db);
}

export async function getTreasuryWallet(db: DbExecutor): Promise<Wallet | null> {
  return (await db.selectFrom('app.wallets').selectAll().where('kind', '=', 'TREASURY').executeTakeFirst()) ?? null;
}

export async function requireTreasuryWallet(db: DbExecutor): Promise<Wallet & { circle_wallet_id: string; address: string }> {
  const treasury = await getTreasuryWallet(db);
  if (!treasury?.circle_wallet_id || !treasury.address) {
    throw new Error('Treasury не зарегистрирован (pnpm circle:bootstrap и перезапуск)');
  }
  return treasury as Wallet & { circle_wallet_id: string; address: string };
}
