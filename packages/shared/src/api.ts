/**
 * Контракт REST API между backend и web.
 *
 * Запросы описаны zod-схемами: бэкенд по ним валидирует вход, фронт проверяет формы.
 * Ответы описаны TypeScript-типами: их формирует наш же бэкенд, рантайм-валидация на фронте не нужна.
 * Все суммы передаются десятичными строками в единицах токена ("12.5"), даты — ISO-8601 строками.
 *
 * Маршруты:
 *   GET  /tokens                              → TokensListDto
 *   GET  /users                               → UsersListDto (новые сверху)
 *   POST /users            CreateUserRequest  → 201 UserSummaryDto (кошелёк создаётся асинхронно: walletStatus=PENDING)
 *   GET  /users/:id                           → UserDetailsDto
 *   GET  /users/:id/operations?limit&cursor   → OperationsPageDto (депозиты, выводы и переводы, новые сверху)
 *   POST /users/:id/withdrawals  + заголовок Idempotency-Key (UUID), CreateWithdrawalRequest → 202 OperationDto
 *   GET  /transfer-recipients/:uid            → TransferRecipientDto (подтверждение получателя перед переводом)
 *   POST /users/:id/transfers    + заголовок Idempotency-Key (UUID), CreateInternalTransferRequest → 201 OperationDto
 *   GET  /users/:id/events                    → SSE (события одного пользователя)
 *   GET  /events                              → SSE (все события: список пользователей, ops)
 *   GET  /ops/overview                        → OpsOverviewDto
 * Ошибки — ApiErrorDto с HTTP-статусом:
 *   400 VALIDATION_ERROR | INVALID_AMOUNT | INVALID_ADDRESS | TOKEN_NOT_SUPPORTED | IDEMPOTENCY_KEY_REQUIRED
 *   404 NOT_FOUND
 *   409 IDEMPOTENCY_KEY_REUSED | WALLET_NOT_READY
 *   422 INSUFFICIENT_FUNDS | ADDRESS_NOT_ALLOWED | RECIPIENT_NOT_FOUND | SELF_TRANSFER
 *   503 SERVICE_UNAVAILABLE, 500 INTERNAL_ERROR
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Запросы
// ---------------------------------------------------------------------------

export const CreateUserRequestSchema = z.object({
  name: z.string().trim().min(1, 'Имя обязательно').max(100, 'Не длиннее 100 символов'),
});
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;

export const CreateWithdrawalRequestSchema = z.object({
  token: z.string().trim().min(1),
  /** Десятичная строка в единицах токена, например "1.25". Точность проверяется на бэкенде по decimals токена. */
  amount: z.string().trim().min(1),
  destinationAddress: z.string().trim().min(1),
});
export type CreateWithdrawalRequest = z.infer<typeof CreateWithdrawalRequestSchema>;

export const CreateInternalTransferRequestSchema = z.object({
  token: z.string().trim().min(1),
  /** Десятичная строка в единицах токена, например "1.25". Точность проверяется на бэкенде по decimals токена. */
  amount: z.string().trim().min(1),
  /** UID получателя — его id пользователя. Регистр не важен: приводим к нижнему, как хранит Postgres. */
  recipientUid: z.string().trim().toLowerCase().pipe(z.uuid({ error: 'Некорректный UID получателя' })),
});
export type CreateInternalTransferRequest = z.infer<typeof CreateInternalTransferRequestSchema>;

/** Заголовок идемпотентности для POST /users/:id/withdrawals и /transfers (UUID, генерируется клиентом на каждую попытку формы). */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

export const OperationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Непрозрачный курсор из nextCursor предыдущей страницы. */
  cursor: z.string().optional(),
});
export type OperationsQuery = z.infer<typeof OperationsQuerySchema>;

// ---------------------------------------------------------------------------
// Ответы
// ---------------------------------------------------------------------------

export interface TokenDto {
  symbol: string;
  decimals: number;
  blockchain: string;
  contractAddress: string;
}

export interface TokensListDto {
  items: TokenDto[];
}

export type WalletStatus = 'PENDING' | 'ACTIVE';

export interface UserSummaryDto {
  id: string;
  name: string;
  createdAt: string;
  /** null, пока кошелёк создаётся в Circle (walletStatus = PENDING). */
  depositAddress: string | null;
  walletStatus: WalletStatus;
}

export interface BalanceDto {
  token: string;
  decimals: number;
  /** Доступно к выводу. */
  available: string;
  /** Зарезервировано под выводы в процессе. */
  held: string;
}

export interface UserDetailsDto extends UserSummaryDto {
  blockchain: string;
  balances: BalanceDto[];
}

export interface UsersListDto {
  items: UserSummaryDto[];
}

/** Перевод по UID: у отправителя — TRANSFER_OUT, у получателя — TRANSFER_IN (одна запись, две стороны). */
export type OperationType = 'DEPOSIT' | 'WITHDRAWAL' | 'TRANSFER_OUT' | 'TRANSFER_IN';

/**
 * Статусы операций.
 * Депозит: PENDING (виден в сети, ждём финализации) → COMPLETED | FAILED.
 * Вывод: PENDING (средства в резерве) → SUBMITTING (отправляем в Circle) → SUBMITTED (в сети) → COMPLETED | FAILED.
 * Перевод по UID: off-chain и атомарен — сразу COMPLETED.
 */
export type DepositStatus = 'PENDING' | 'COMPLETED' | 'FAILED';
export type WithdrawalStatus = 'PENDING' | 'SUBMITTING' | 'SUBMITTED' | 'COMPLETED' | 'FAILED';
export type InternalTransferStatus = 'COMPLETED';
export type OperationStatus = DepositStatus | WithdrawalStatus | InternalTransferStatus;

export const FINAL_OPERATION_STATUSES: readonly OperationStatus[] = ['COMPLETED', 'FAILED'];

export interface OperationDto {
  id: string;
  type: OperationType;
  token: string;
  amount: string;
  status: OperationStatus;
  /** Сырое состояние транзакции в Circle (INITIATED, QUEUED, SENT, CONFIRMED, COMPLETE, ...), если уже известно. */
  circleState: string | null;
  /** У переводов по UID всегда null: они off-chain. */
  txHash: string | null;
  /** Для депозита — адрес отправителя (если Circle его сообщил), для вывода — адрес получателя. */
  counterpartyAddress: string | null;
  /** Только для переводов по UID: UID второй стороны (получателя у TRANSFER_OUT, отправителя у TRANSFER_IN). */
  counterpartyUid: string | null;
  /** Только для выводов: вывод ждёт ликвидности treasury (sweep ещё не завершён). */
  awaitingLiquidity: boolean;
  errorReason: string | null;
  errorDetails: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/** Получатель перевода для подтверждения: только маскированное имя — без балансов и адресов. */
export interface TransferRecipientDto {
  uid: string;
  /** «Iv***»: достаточно, чтобы отправитель узнал получателя, но не раскрывает имя целиком. */
  maskedName: string;
}

export interface OperationsPageDto {
  items: OperationDto[];
  nextCursor: string | null;
}

export interface OpsTokenOverviewDto {
  token: string;
  decimals: number;
  /** Σ CUSTODY по всем кошелькам — сколько токена фактически под управлением сервиса по леджеру. */
  custodyTotal: string;
  /** CUSTODY treasury. */
  treasuryCustody: string;
  /** Выводы в SUBMITTING/SUBMITTED — уже «обещанная» часть treasury. */
  inFlightWithdrawals: string;
  /** Ликвидность для новых выводов = treasuryCustody − inFlightWithdrawals. */
  treasuryLiquidity: string;
  /** Σ CUSTODY deposit-кошельков, ещё не сметённая в treasury. */
  unsweptDeposits: string;
  usersAvailable: string;
  usersHeld: string;
  house: string;
  /** Глобальное тождество леджера: Σ CUSTODY = Σ USER_AVAILABLE + Σ USER_HELD + Σ HOUSE. */
  ledgerBalanced: boolean;
}

export interface OpsJobStatsDto {
  pending: number;
  running: number;
  dead: number;
}

export interface OpsDeadJobDto {
  id: string;
  kind: string;
  attempts: number;
  lastError: string | null;
  updatedAt: string;
}

export interface OpsBalanceCheckDto {
  walletId: string;
  walletKind: 'DEPOSIT' | 'TREASURY';
  address: string | null;
  token: string;
  ledgerCustody: string;
  /** Исходящие переводы в пути (sweep с deposit-кошелька / выводы с treasury): on-chain уже ушли, в леджере — ещё нет. */
  inFlightOut: string;
  onChain: string;
  /**
   * on-chain − (ledger − inFlightOut). Отрицательное значение — тревога: на кошельке меньше, чем должно быть.
   * Положительное временно нормально (депозиты, ещё не финализированные, неклассифицированные поступления).
   */
  difference: string;
  checkedAt: string;
}

export interface OpsSweepDto {
  id: string;
  walletAddress: string | null;
  token: string;
  amount: string;
  status: 'PENDING' | 'SUBMITTED' | 'COMPLETED' | 'FAILED';
  circleState: string | null;
  txHash: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface OpsTreasuryInboundDto {
  id: string;
  token: string;
  amount: string;
  classification: 'PENDING' | 'SWEEP' | 'HOUSE_FUNDING' | 'UNCLASSIFIED' | 'FAILED';
  sourceAddress: string | null;
  txHash: string | null;
  circleState: string;
  createdAt: string;
}

export interface OpsOverviewDto {
  treasury: {
    walletId: string;
    address: string | null;
    status: WalletStatus;
  } | null;
  blockchain: string;
  tokens: OpsTokenOverviewDto[];
  jobs: OpsJobStatsDto;
  deadJobs: OpsDeadJobDto[];
  balanceChecks: OpsBalanceCheckDto[];
  recentSweeps: OpsSweepDto[];
  recentTreasuryInbounds: OpsTreasuryInboundDto[];
}

// ---------------------------------------------------------------------------
// Ошибки
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'TOKEN_NOT_SUPPORTED'
  | 'INVALID_AMOUNT'
  | 'INVALID_ADDRESS'
  | 'ADDRESS_NOT_ALLOWED'
  | 'INSUFFICIENT_FUNDS'
  | 'RECIPIENT_NOT_FOUND'
  | 'SELF_TRANSFER'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'WALLET_NOT_READY'
  | 'WEBHOOK_SIGNATURE_INVALID'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface ApiErrorDto {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

/**
 * События SSE-стримов GET /users/:id/events и GET /events.
 * Это только сигналы «данные устарели» — сами данные клиент перечитывает по REST.
 *
 * event: invalidate  data: {"userId": "<uuid>" | null}   (null — изменение treasury/ops-уровня)
 * event: resync      data: {}                            (сервер мог пропустить события — перечитать всё)
 * event: ready       data: {}                            (подключение установлено — перечитать всё)
 */
export type SseEventName = 'invalidate' | 'resync' | 'ready';

export interface SseInvalidatePayload {
  userId: string | null;
}
