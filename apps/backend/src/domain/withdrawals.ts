/**
 * Выводы (design-doc §8.4). Самая чувствительная часть системы: здесь деньги уходят наружу.
 *
 * Поток:
 *  1. API: одна транзакция — блокировка USER_AVAILABLE, проверка средств, withdrawals(PENDING),
 *     проводка WITHDRAWAL_HOLD (available → held), задача withdrawal.submit. Ответ 202.
 *  2. Worker: блокировка CUSTODY(treasury), проверка ликвидности (custody − выводы в пути);
 *     PENDING → SUBMITTING; commit; вызов Circle с idempotencyKey = withdrawal.id.
 *  3. Вебхуки/reconciliation: COMPLETE → WITHDRAWAL_SETTLE (held → наружу из treasury),
 *     FAILED/DENIED/CANCELLED → WITHDRAWAL_RELEASE (held → available).
 * Двойная отправка невозможна: idempotencyKey детерминирован, а при повторе после неизвестного исхода
 * мы сначала ищем транзакцию по refId.
 */
import { createHash } from 'node:crypto';
import { formatUnits, MoneyFormatError, parseUnits, type CreateWithdrawalRequest } from '@circle-wallet/shared';
import { sql } from 'kysely';
import { getAddress, isAddress, zeroAddress } from 'viem';
import { isCircleError } from '../circle/errors';
import type { CircleTransaction } from '../circle/gateway';
import { isUniqueViolation } from '../db/errors';
import type { Tx } from '../db/client';
import type { Withdrawal, WithdrawalStatus } from '../db/schema';
import { AppError, notFound } from '../lib/errors';
import { enqueueJob, wakeWithdrawalsAwaitingLiquidity } from '../jobs/queue';
import { isFailureState, isSuccessState, isTerminalState, shouldApplyState } from './circle-state';
import type { AppContext } from './context';
import { RetryLaterError } from './context';
import { custody, lockAccount, postLedgerTransaction, userAvailable, userHeld } from './ledger';
import { getTreasuryWallet, requireTreasuryWallet } from './wallets';

export const withdrawalRefId = (id: string) => `withdrawal:${id}`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// 1. Создание вывода (API)
// ---------------------------------------------------------------------------

export async function createWithdrawal(
  ctx: AppContext,
  userId: string,
  idempotencyKey: string | undefined,
  request: CreateWithdrawalRequest,
): Promise<{ withdrawal: Withdrawal; replayed: boolean }> {
  if (!idempotencyKey || !UUID_RE.test(idempotencyKey)) {
    throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 400, 'Нужен заголовок Idempotency-Key (UUID)');
  }

  const token = ctx.tokens.bySymbol(request.token);
  if (!token) throw new AppError('TOKEN_NOT_SUPPORTED', 400, `Токен ${request.token} не поддерживается`);

  let amount: bigint;
  try {
    amount = parseUnits(request.amount, token.decimals);
  } catch (e) {
    throw new AppError('INVALID_AMOUNT', 400, e instanceof MoneyFormatError ? e.message : 'Некорректная сумма');
  }
  if (amount <= 0n) throw new AppError('INVALID_AMOUNT', 400, 'Сумма должна быть больше нуля');

  const destination = normalizeDestination(request.destinationAddress);
  await assertDestinationAllowed(ctx, userId, destination);

  // Хэш нормализованного запроса: тот же ключ с другим телом — ошибка клиента (409), а не новый вывод.
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ token: token.symbol, amount: amount.toString(), destination }))
    .digest('hex');

  try {
    return await ctx.db.transaction().execute(async (trx) => {
      const existing = await findByIdempotencyKey(trx, userId, idempotencyKey);
      if (existing) return { withdrawal: assertSameRequest(existing, requestHash), replayed: true };

      const user = await trx.selectFrom('app.users').select('id').where('id', '=', userId).executeTakeFirst();
      if (!user) throw notFound('Пользователь');

      // Блокировка счёта сериализует параллельные выводы одного пользователя: второй увидит уже уменьшенный баланс.
      const available = await lockAccount(trx, userAvailable(userId, token.symbol));
      // Повторная проверка ключа ПОСЛЕ блокировки: параллельный запрос с тем же ключом мог закоммитить вывод,
      // пока мы ждали блокировку. Без этого мы ответили бы ему 422 «недостаточно средств» вместо того же вывода.
      const concurrent = await findByIdempotencyKey(trx, userId, idempotencyKey);
      if (concurrent) return { withdrawal: assertSameRequest(concurrent, requestHash), replayed: true };
      if (available.balance < amount) {
        throw new AppError('INSUFFICIENT_FUNDS', 422, 'Недостаточно средств', {
          available: formatUnits(available.balance, token.decimals),
        });
      }

      const withdrawal = await trx
        .insertInto('app.withdrawals')
        .values({
          user_id: userId,
          token: token.symbol,
          amount: amount.toString(),
          destination_address: destination,
          idempotency_key: idempotencyKey,
          request_hash: requestHash,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await postLedgerTransaction(trx, {
        kind: 'WITHDRAWAL_HOLD',
        referenceId: withdrawal.id,
        lines: [
          { account: userAvailable(userId, token.symbol), direction: 'DEBIT', amount },
          { account: userHeld(userId, token.symbol), direction: 'CREDIT', amount },
        ],
      });
      await enqueueJob(trx, 'withdrawal.submit', { withdrawalId: withdrawal.id }, { dedupeKey: `withdrawal:${withdrawal.id}` });
      return { withdrawal, replayed: false };
    });
  } catch (error) {
    // Гонка двух запросов с одним ключом: второй упал на UNIQUE — отдаём результат первого.
    if (isUniqueViolation(error, 'withdrawals_idempotency')) {
      const existing = await findByIdempotencyKey(ctx.db, userId, idempotencyKey);
      if (existing) return { withdrawal: assertSameRequest(existing, requestHash), replayed: true };
    }
    throw error;
  }
}

function normalizeDestination(address: string): string {
  // viem.isAddress проверяет и формат, и EIP-55 checksum, если адрес в смешанном регистре.
  if (!isAddress(address)) {
    throw new AppError('INVALID_ADDRESS', 400, 'Некорректный адрес (ожидается EVM-адрес 0x… с корректной checksum)');
  }
  return getAddress(address).toLowerCase();
}

async function assertDestinationAllowed(ctx: AppContext, userId: string, destination: string): Promise<void> {
  const reject = (message: string) => {
    throw new AppError('ADDRESS_NOT_ALLOWED', 422, message);
  };
  if (destination === zeroAddress) reject('Вывод на нулевой адрес запрещён: средства будут потеряны');
  if (ctx.tokens.contractAddresses().has(destination)) {
    reject('Вывод на адрес контракта токена запрещён: средства будут заблокированы навсегда');
  }
  const treasury = await getTreasuryWallet(ctx.db);
  if (treasury?.address === destination) reject('Вывод на treasury-адрес сервиса запрещён');
  const own = await ctx.db
    .selectFrom('app.wallets')
    .select('id')
    .where('kind', '=', 'DEPOSIT')
    .where('user_id', '=', userId)
    .where('address', '=', destination)
    .executeTakeFirst();
  if (own) reject('Нельзя вывести средства на собственный адрес пополнения');
}

function findByIdempotencyKey(db: AppContext['db'] | Tx, userId: string, key: string) {
  return db
    .selectFrom('app.withdrawals')
    .selectAll()
    .where('user_id', '=', userId)
    .where('idempotency_key', '=', key)
    .executeTakeFirst();
}

function assertSameRequest(existing: Withdrawal, requestHash: string): Withdrawal {
  if (existing.request_hash !== requestHash) {
    throw new AppError('IDEMPOTENCY_KEY_REUSED', 409, 'Idempotency-Key уже использован для другого запроса');
  }
  return existing;
}

// ---------------------------------------------------------------------------
// 2. Отправка в Circle (worker, задача withdrawal.submit)
// ---------------------------------------------------------------------------

export type SubmitOutcome =
  | { type: 'done'; result: string }
  | { type: 'wait_liquidity' };

export async function submitWithdrawal(ctx: AppContext, withdrawalId: string): Promise<SubmitOutcome> {
  // Фаза 1 (транзакция): зарезервировать ликвидность treasury и перевести вывод в SUBMITTING.
  const phase1 = await ctx.db.transaction().execute(async (trx) => {
    const w = await trx.selectFrom('app.withdrawals').selectAll().where('id', '=', withdrawalId).forUpdate().executeTakeFirst();
    if (!w) return { type: 'done' as const, result: 'IGNORED:not_found' };
    if (w.status === 'SUBMITTED' || isFinalStatus(w.status)) return { type: 'done' as const, result: `NOOP:${w.status}` };
    if (w.status === 'SUBMITTING') return { type: 'resume' as const, withdrawal: w };

    const treasury = await requireTreasuryWallet(trx);
    // Блокировка CUSTODY(treasury) сериализует решения о ликвидности: два воркера не «потратят» одни и те же средства.
    const treasuryCustody = await lockAccount(trx, custody(treasury.id, w.token));
    const inFlight = await inFlightAmount(trx, w.token);
    const liquidity = treasuryCustody.balance - inFlight;
    const amount = BigInt(w.amount);
    if (liquidity < amount) {
      if (!w.awaiting_liquidity) {
        await trx.updateTable('app.withdrawals').set({ awaiting_liquidity: true }).where('id', '=', w.id).execute();
      }
      return { type: 'wait' as const };
    }
    await trx
      .updateTable('app.withdrawals')
      .set({ status: 'SUBMITTING', awaiting_liquidity: false })
      .where('id', '=', w.id)
      .execute();
    return { type: 'submit' as const, withdrawal: { ...w, status: 'SUBMITTING' as const } };
  });

  if (phase1.type === 'done') return phase1;
  if (phase1.type === 'wait') return { type: 'wait_liquidity' };
  const withdrawal = phase1.withdrawal;
  const treasury = await requireTreasuryWallet(ctx.db);
  const token = ctx.tokens.bySymbol(withdrawal.token)!;

  // Повторная попытка после неизвестного исхода: возможно, перевод уже создан — ищем по refId.
  // Это оптимизация (fail soft): даже без неё повтор с тем же idempotencyKey безопасен.
  if (phase1.type === 'resume') {
    const found = await findOutboundByRefId(ctx, treasury.circle_wallet_id, withdrawalRefId(withdrawal.id));
    if (found) {
      await applyWithdrawalTransaction(ctx, found, 'submit');
      return { type: 'done', result: 'RECOVERED_BY_REF_ID' };
    }
  }

  let created: { id: string; state: string };
  try {
    created = await ctx.circle.createTransfer({
      idempotencyKey: withdrawal.id,
      walletId: treasury.circle_wallet_id,
      tokenId: token.circle_token_id,
      destinationAddress: withdrawal.destination_address,
      amount: formatUnits(BigInt(withdrawal.amount), token.decimals),
      refId: withdrawalRefId(withdrawal.id),
    });
  } catch (error) {
    if (isCircleError(error) && error.kind === 'DEFINITIVE') {
      if (phase1.type === 'submit') {
        // Первая попытка, и Circle отказал по существу (невалидный адрес и т.п.) — перевод точно не создан:
        // возвращаем деньги.
        await ctx.db.transaction().execute((trx) => failWithdrawal(trx, withdrawal.id, 'REJECTED_BY_CIRCLE', error.message));
        ctx.logger.warn({ withdrawalId: withdrawal.id, err: error }, 'withdrawal rejected by Circle');
        return { type: 'done', result: 'FAILED:rejected' };
      }
      // Повтор после неизвестного исхода: первый запрос мог создать перевод, а 4xx на повтор
      // (например, «запрос с этим ключом ещё обрабатывается») не доказывает обратного.
      // Освобождать резерв нельзя — ретраим; если не сойдётся, задача уйдёт в DEAD на ручной разбор.
      ctx.logger.error({ withdrawalId: withdrawal.id, err: error }, 'definitive error on resubmit — keeping funds held');
    }
    // Исход неизвестен или временная ошибка — вывод остаётся SUBMITTING (резерв держится), задача повторится.
    throw error;
  }

  // Ответ Circle применяем через ту же state machine, что и вебхуки: при повторе Circle может вернуть
  // уже терминальное состояние (COMPLETE/FAILED), и оно должно провести SETTLE/RELEASE, а не «заморозить» вывод.
  const result = await applyWithdrawalTransaction(
    ctx,
    {
      id: created.id,
      transactionType: 'OUTBOUND',
      state: created.state,
      walletId: treasury.circle_wallet_id,
      tokenId: token.circle_token_id,
      amount: null,
      txHash: null,
      refId: withdrawalRefId(withdrawal.id),
      sourceAddress: null,
      destinationAddress: withdrawal.destination_address,
      errorReason: null,
      errorDetails: null,
    },
    'submit',
  );
  ctx.logger.info({ withdrawalId: withdrawal.id, circleTransactionId: created.id, result }, 'withdrawal submitted to Circle');
  return { type: 'done', result: 'SUBMITTED' };
}

async function inFlightAmount(trx: Tx, token: string): Promise<bigint> {
  const row = await trx
    .selectFrom('app.withdrawals')
    .select(sql<string>`coalesce(sum(amount), 0)::text`.as('total'))
    .where('token', '=', token)
    .where('status', 'in', ['SUBMITTING', 'SUBMITTED'])
    .executeTakeFirstOrThrow();
  return BigInt(row.total);
}

async function findOutboundByRefId(ctx: AppContext, circleWalletId: string, refId: string): Promise<CircleTransaction | null> {
  try {
    const page = await ctx.circle.listTransactions({ walletIds: [circleWalletId], txType: 'OUTBOUND', refId, pageSize: 10 });
    return page.items.find((t) => t.refId === refId) ?? null;
  } catch (error) {
    ctx.logger.warn({ err: error, refId }, 'refId lookup failed, falling back to idempotent resubmit');
    return null;
  }
}

const isFinalStatus = (status: WithdrawalStatus) => status === 'COMPLETED' || status === 'FAILED';

// ---------------------------------------------------------------------------
// 3. Применение состояния Circle (вебхук / reconciliation)
// ---------------------------------------------------------------------------

export function withdrawalStatusFor(state: string): WithdrawalStatus {
  if (isSuccessState(state)) return 'COMPLETED';
  if (isFailureState(state)) return 'FAILED';
  return 'SUBMITTED';
}

export async function applyWithdrawalTransaction(
  ctx: AppContext,
  tx: CircleTransaction,
  source: 'webhook' | 'reconcile' | 'submit',
): Promise<string> {
  return ctx.db.transaction().execute(async (trx) => {
    const withdrawal = await findWithdrawalForTransaction(trx, tx);
    if (!withdrawal) {
      // Вебхук мог прийти раньше, чем сохранён ответ Circle на create transfer: повторим позже.
      if (source === 'webhook') throw new RetryLaterError(`withdrawal for Circle tx ${tx.id} not found yet`);
      return 'IGNORED:unknown_outbound';
    }
    if (isFinalStatus(withdrawal.status)) {
      if (withdrawal.status === 'FAILED' && isSuccessState(tx.state)) {
        // Такого быть не должно (резерв уже возвращён) — громко сигналим для ручного разбора.
        ctx.logger.error({ withdrawalId: withdrawal.id, circleTransactionId: tx.id }, 'withdrawal COMPLETED after being marked FAILED — manual review');
      }
      return `NOOP:${withdrawal.status}`;
    }
    if (!shouldApplyState(withdrawal.circle_state, tx.state)) {
      // Состояние то же (или старее), но id/хэш могли появиться впервые — дозаполним без смены статуса.
      if (!withdrawal.circle_transaction_id || (!withdrawal.tx_hash && tx.txHash)) {
        await trx
          .updateTable('app.withdrawals')
          .set({
            circle_transaction_id: withdrawal.circle_transaction_id ?? tx.id,
            tx_hash: withdrawal.tx_hash ?? tx.txHash,
            status: withdrawal.status === 'SUBMITTING' ? 'SUBMITTED' : withdrawal.status,
          })
          .where('id', '=', withdrawal.id)
          .execute();
      }
      return 'NOOP:stale_state';
    }

    const nextStatus = withdrawalStatusFor(tx.state);
    await trx
      .updateTable('app.withdrawals')
      .set({
        status: nextStatus,
        circle_transaction_id: withdrawal.circle_transaction_id ?? tx.id,
        circle_state: tx.state,
        tx_hash: tx.txHash ?? withdrawal.tx_hash,
        error_reason: tx.errorReason,
        error_details: tx.errorDetails,
        submitted_at: withdrawal.submitted_at ?? new Date(),
        ...(isTerminalState(tx.state) ? { completed_at: new Date() } : {}),
      })
      .where('id', '=', withdrawal.id)
      .execute();

    const amount = BigInt(withdrawal.amount);
    if (nextStatus === 'COMPLETED') {
      const treasury = await requireTreasuryWallet(trx);
      await postLedgerTransaction(trx, {
        kind: 'WITHDRAWAL_SETTLE',
        referenceId: withdrawal.id,
        description: `Withdrawal ${tx.id}`,
        lines: [
          { account: userHeld(withdrawal.user_id, withdrawal.token), direction: 'DEBIT', amount },
          { account: custody(treasury.id, withdrawal.token), direction: 'CREDIT', amount },
        ],
      });
      ctx.logger.info({ withdrawalId: withdrawal.id, txHash: tx.txHash }, 'withdrawal completed');
    } else if (nextStatus === 'FAILED') {
      await releaseHold(trx, withdrawal);
      ctx.logger.warn({ withdrawalId: withdrawal.id, state: tx.state, reason: tx.errorReason }, 'withdrawal failed');
    }
    return `APPLIED:${nextStatus}`;
  });
}

async function findWithdrawalForTransaction(trx: Tx, tx: CircleTransaction): Promise<Withdrawal | undefined> {
  const byCircleId = await trx
    .selectFrom('app.withdrawals')
    .selectAll()
    .where('circle_transaction_id', '=', tx.id)
    .forUpdate()
    .executeTakeFirst();
  if (byCircleId) return byCircleId;
  const refPrefix = 'withdrawal:';
  const refId = tx.refId?.startsWith(refPrefix) ? tx.refId.slice(refPrefix.length) : null;
  if (!refId || !UUID_RE.test(refId)) return undefined;
  return trx.selectFrom('app.withdrawals').selectAll().where('id', '=', refId).forUpdate().executeTakeFirst();
}

/** Вывод не выполнен: статус FAILED и проводка WITHDRAWAL_RELEASE (held → available) — одной транзакцией. */
export async function failWithdrawal(trx: Tx, withdrawalId: string, reason: string, details: string | null): Promise<void> {
  const withdrawal = await trx
    .selectFrom('app.withdrawals')
    .selectAll()
    .where('id', '=', withdrawalId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  // Освобождать резерв без события Circle можно, только пока перевод точно не создан:
  // у вывода нет circle_transaction_id и он ещё не принят Circle (PENDING/SUBMITTING).
  if (!(withdrawal.status === 'PENDING' || withdrawal.status === 'SUBMITTING') || withdrawal.circle_transaction_id) return;
  await trx
    .updateTable('app.withdrawals')
    .set({ status: 'FAILED', error_reason: reason, error_details: details, completed_at: new Date(), awaiting_liquidity: false })
    .where('id', '=', withdrawalId)
    .execute();
  await releaseHold(trx, withdrawal);
}

async function releaseHold(trx: Tx, withdrawal: Withdrawal): Promise<void> {
  const amount = BigInt(withdrawal.amount);
  // Тот же порядок блокировок, что в createWithdrawal (сначала USER_AVAILABLE, потом USER_HELD),
  // иначе создание и отмена вывода одного пользователя могут поймать deadlock.
  await lockAccount(trx, userAvailable(withdrawal.user_id, withdrawal.token));
  await postLedgerTransaction(trx, {
    kind: 'WITHDRAWAL_RELEASE',
    referenceId: withdrawal.id,
    lines: [
      { account: userHeld(withdrawal.user_id, withdrawal.token), direction: 'DEBIT', amount },
      { account: userAvailable(withdrawal.user_id, withdrawal.token), direction: 'CREDIT', amount },
    ],
  });
  // Резерв ликвидности treasury освободился — выводы, ждущие её, могут пойти сразу.
  await wakeWithdrawalsAwaitingLiquidity(trx);
}
