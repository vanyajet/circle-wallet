/**
 * Внутренние переводы между пользователями по UID (design-doc §8.6, ADR-0010).
 *
 * Off-chain: при omnibus средства пользователей лежат на кошельках сервиса, а принадлежность определяет
 * только леджер. Перевод — одна транзакция в API: блокировка USER_AVAILABLE обеих сторон, проверка средств,
 * internal_transfers(COMPLETED) и проводка INTERNAL_TRANSFER (available отправителя → available получателя).
 * Circle, worker и блокчейн не участвуют, CUSTODY не меняется: деньги физически остаются там, где лежали
 * (на treasury или ещё на deposit-кошельке до sweep). Внешнего эффекта нет — поэтому нет ни outbox-задачи,
 * ни промежуточных статусов, ни окна для сбоя: перевод мгновенный, бесплатный и атомарный.
 */
import { createHash } from 'node:crypto';
import {
  formatUnits,
  MoneyFormatError,
  parseUnits,
  type CreateInternalTransferRequest,
  type TransferRecipientDto,
} from '@circle-wallet/shared';
import type { Tx } from '../db/client';
import { isUniqueViolation } from '../db/errors';
import type { InternalTransfer } from '../db/schema';
import { AppError, notFound } from '../lib/errors';
import type { AppContext } from './context';
import { lockAccounts, postLedgerTransaction, userAvailable } from './ledger';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createInternalTransfer(
  ctx: AppContext,
  senderUserId: string,
  idempotencyKey: string | undefined,
  request: CreateInternalTransferRequest,
): Promise<{ transfer: InternalTransfer; replayed: boolean }> {
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

  // UUID в нижнем регистре, как его выводит Postgres: иначе один и тот же UID в разном регистре
  // обошёл бы проверку «самому себе» и дал бы другой request_hash (409 на честный повтор).
  const senderId = senderUserId.toLowerCase();
  const recipientId = request.recipientUid.trim().toLowerCase();
  if (!UUID_RE.test(recipientId)) throw new AppError('VALIDATION_ERROR', 400, 'Некорректный UID получателя');
  if (recipientId === senderId) throw new AppError('SELF_TRANSFER', 422, 'Нельзя перевести средства самому себе');

  // Хэш нормализованного запроса: тот же ключ с другим телом — ошибка клиента (409), а не новый перевод.
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ token: token.symbol, amount: amount.toString(), recipient: recipientId }))
    .digest('hex');

  try {
    const result = await ctx.db.transaction().execute(async (trx) => {
      const existing = await findByIdempotencyKey(trx, senderId, idempotencyKey);
      if (existing) return { transfer: assertSameRequest(existing, requestHash), replayed: true };

      const users = await trx.selectFrom('app.users').select('id').where('id', 'in', [senderId, recipientId]).execute();
      if (!users.some((u) => u.id === senderId)) throw notFound('Пользователь');
      if (!users.some((u) => u.id === recipientId)) {
        throw new AppError('RECIPIENT_NOT_FOUND', 422, 'Получатель с таким UID не найден');
      }

      // Оба счёта — в детерминированном порядке (см. lockAccounts): встречные переводы A→B и B→A не ловят
      // deadlock, а параллельные переводы одного отправителя видят уже уменьшенный баланс.
      const [available] = await lockAccounts(trx, [
        userAvailable(senderId, token.symbol),
        userAvailable(recipientId, token.symbol),
      ]);
      // Повторная проверка ключа ПОСЛЕ блокировки: параллельный запрос с тем же ключом мог закоммитить перевод,
      // пока мы ждали блокировку. Без этого мы ответили бы ему 422 «недостаточно средств» вместо того же перевода.
      const concurrent = await findByIdempotencyKey(trx, senderId, idempotencyKey);
      if (concurrent) return { transfer: assertSameRequest(concurrent, requestHash), replayed: true };
      if (available!.balance < amount) {
        throw new AppError('INSUFFICIENT_FUNDS', 422, 'Недостаточно средств', {
          available: formatUnits(available!.balance, token.decimals),
        });
      }

      const transfer = await trx
        .insertInto('app.internal_transfers')
        .values({
          sender_user_id: senderId,
          recipient_user_id: recipientId,
          token: token.symbol,
          amount: amount.toString(),
          idempotency_key: idempotencyKey,
          request_hash: requestHash,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await postLedgerTransaction(trx, {
        kind: 'INTERNAL_TRANSFER',
        referenceId: transfer.id,
        lines: [
          { account: userAvailable(senderId, token.symbol), direction: 'DEBIT', amount },
          { account: userAvailable(recipientId, token.symbol), direction: 'CREDIT', amount },
        ],
      });
      return { transfer, replayed: false };
    });
    if (!result.replayed) {
      ctx.logger.info(
        { transferId: result.transfer.id, senderId, recipientId, token: token.symbol, amount: amount.toString() },
        'internal transfer completed',
      );
    }
    return result;
  } catch (error) {
    // Гонка двух запросов с одним ключом (на разные счета — не встретились на блокировке): второй упал на UNIQUE.
    if (isUniqueViolation(error, 'internal_transfers_idempotency')) {
      const existing = await findByIdempotencyKey(ctx.db, senderId, idempotencyKey);
      if (existing) return { transfer: assertSameRequest(existing, requestHash), replayed: true };
    }
    throw error;
  }
}

/** Получатель для подтверждения перед переводом: только маскированное имя, без балансов и адресов. */
export async function getTransferRecipient(ctx: AppContext, uid: string): Promise<TransferRecipientDto> {
  const user = await ctx.db.selectFrom('app.users').select(['id', 'name']).where('id', '=', uid).executeTakeFirst();
  if (!user) throw notFound('Получатель');
  return { uid: user.id, maskedName: maskName(user.name) };
}

/** «Ivan Petrov» → «Iv***». Режем по code points, а не UTF-16: эмодзи и суррогатные пары не разрываются. */
export function maskName(name: string): string {
  const chars = Array.from(name.trim());
  return `${chars.slice(0, chars.length > 2 ? 2 : 1).join('')}***`;
}

function findByIdempotencyKey(db: AppContext['db'] | Tx, senderId: string, key: string) {
  return db
    .selectFrom('app.internal_transfers')
    .selectAll()
    .where('sender_user_id', '=', senderId)
    .where('idempotency_key', '=', key)
    .executeTakeFirst();
}

function assertSameRequest(existing: InternalTransfer, requestHash: string): InternalTransfer {
  if (existing.request_hash !== requestHash) {
    throw new AppError('IDEMPOTENCY_KEY_REUSED', 409, 'Idempotency-Key уже использован для другого запроса');
  }
  return existing;
}
