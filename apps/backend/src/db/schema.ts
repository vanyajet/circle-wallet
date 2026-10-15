/**
 * Типы таблиц схемы app для Kysely. Соответствуют миграциям в supabase/migrations.
 *
 * numeric(78,0) драйвер pg отдаёт строкой — это и нужно: в домене строка сразу превращается в bigint,
 * без промежуточного number (иначе потеря точности после 2^53).
 */
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/** numeric: читаем строкой, пишем строкой или bigint. */
type Numeric = ColumnType<string, string | bigint, string | bigint>;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Json = ColumnType<unknown, string, string>;

export type WalletKind = 'DEPOSIT' | 'TREASURY';
export type WalletStatus = 'PENDING' | 'ACTIVE';
export type AccountType = 'USER_AVAILABLE' | 'USER_HELD' | 'CUSTODY' | 'HOUSE';
export type LedgerKind =
  | 'DEPOSIT_CREDIT'
  | 'WITHDRAWAL_HOLD'
  | 'WITHDRAWAL_SETTLE'
  | 'WITHDRAWAL_RELEASE'
  | 'SWEEP_SETTLE'
  | 'HOUSE_FUNDING';
export type Direction = 'DEBIT' | 'CREDIT';
export type DepositStatus = 'PENDING' | 'COMPLETED' | 'FAILED';
export type WithdrawalStatus = 'PENDING' | 'SUBMITTING' | 'SUBMITTED' | 'COMPLETED' | 'FAILED';
export type SweepStatus = 'PENDING' | 'SUBMITTED' | 'COMPLETED' | 'FAILED';
export type TreasuryInboundClassification = 'PENDING' | 'SWEEP' | 'HOUSE_FUNDING' | 'UNCLASSIFIED' | 'FAILED';
export type JobStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'DEAD';

export interface TokensTable {
  symbol: string;
  blockchain: string;
  circle_token_id: string;
  contract_address: string;
  decimals: number;
  is_enabled: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface UsersTable {
  id: Generated<string>;
  name: string;
  created_at: Generated<Date>;
}

export interface WalletsTable {
  id: Generated<string>;
  kind: WalletKind;
  user_id: string | null;
  status: Generated<WalletStatus>;
  blockchain: string;
  circle_wallet_id: string | null;
  address: string | null;
  circle_idempotency_key: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface LedgerAccountsTable {
  id: Generated<string>;
  type: AccountType;
  token: string;
  user_id: string | null;
  wallet_id: string | null;
  balance: ColumnType<string, never, never>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface LedgerTransactionsTable {
  id: Generated<string>;
  kind: LedgerKind;
  reference_id: string;
  description: string | null;
  created_at: Generated<Date>;
}

export interface LedgerEntriesTable {
  id: ColumnType<string, never, never>;
  transaction_id: string;
  account_id: string;
  direction: Direction;
  amount: Numeric;
  created_at: Generated<Date>;
}

export interface DepositsTable {
  id: Generated<string>;
  user_id: string;
  wallet_id: string;
  token: string;
  amount: Numeric;
  status: DepositStatus;
  circle_transaction_id: string;
  circle_state: string;
  tx_hash: string | null;
  source_address: string | null;
  error_reason: string | null;
  error_details: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  completed_at: NullableTimestamp;
  /** Когда операцию последний раз сверяли с Circle (reconcile.pending). */
  last_reconciled_at: NullableTimestamp;
}

export interface WithdrawalsTable {
  id: Generated<string>;
  user_id: string;
  token: string;
  amount: Numeric;
  destination_address: string;
  status: Generated<WithdrawalStatus>;
  awaiting_liquidity: Generated<boolean>;
  idempotency_key: string;
  request_hash: string;
  circle_transaction_id: string | null;
  circle_state: string | null;
  tx_hash: string | null;
  error_reason: string | null;
  error_details: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  submitted_at: NullableTimestamp;
  completed_at: NullableTimestamp;
  /** Когда операцию последний раз сверяли с Circle (reconcile.pending). */
  last_reconciled_at: NullableTimestamp;
}

export interface SweepsTable {
  id: Generated<string>;
  wallet_id: string;
  token: string;
  amount: Numeric;
  status: Generated<SweepStatus>;
  circle_transaction_id: string | null;
  circle_state: string | null;
  tx_hash: string | null;
  error_reason: string | null;
  error_details: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  submitted_at: NullableTimestamp;
  completed_at: NullableTimestamp;
  /** Когда операцию последний раз сверяли с Circle (reconcile.pending). */
  last_reconciled_at: NullableTimestamp;
}

export interface TreasuryInboundsTable {
  id: Generated<string>;
  wallet_id: string;
  token: string;
  amount: Numeric;
  circle_transaction_id: string;
  circle_state: string;
  tx_hash: string | null;
  source_address: string | null;
  classification: Generated<TreasuryInboundClassification>;
  sweep_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  classified_at: NullableTimestamp;
  /** Когда операцию последний раз сверяли с Circle (reconcile.pending). */
  last_reconciled_at: NullableTimestamp;
}

export interface WebhookEventsTable {
  notification_id: string;
  notification_type: string;
  subscription_id: string | null;
  payload: Json;
  received_at: Generated<Date>;
  processed_at: NullableTimestamp;
  result: string | null;
}

export interface JobsTable {
  id: ColumnType<string, never, never>;
  kind: string;
  payload: Json;
  status: Generated<JobStatus>;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  run_at: Timestamp;
  locked_by: string | null;
  locked_until: NullableTimestamp;
  dedupe_key: string | null;
  last_error: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  finished_at: NullableTimestamp;
}

export interface SyncCursorsTable {
  name: string;
  cursor: Timestamp;
  updated_at: Generated<Date>;
}

export interface BalanceChecksTable {
  wallet_id: string;
  token: string;
  ledger_custody: Numeric;
  on_chain: Numeric;
  checked_at: Generated<Date>;
}

export interface Database {
  'app.tokens': TokensTable;
  'app.users': UsersTable;
  'app.wallets': WalletsTable;
  'app.ledger_accounts': LedgerAccountsTable;
  'app.ledger_transactions': LedgerTransactionsTable;
  'app.ledger_entries': LedgerEntriesTable;
  'app.deposits': DepositsTable;
  'app.withdrawals': WithdrawalsTable;
  'app.sweeps': SweepsTable;
  'app.treasury_inbounds': TreasuryInboundsTable;
  'app.webhook_events': WebhookEventsTable;
  'app.jobs': JobsTable;
  'app.sync_cursors': SyncCursorsTable;
  'app.balance_checks': BalanceChecksTable;
}

export type Wallet = Selectable<WalletsTable>;
export type Token = Selectable<TokensTable>;
export type Deposit = Selectable<DepositsTable>;
export type Withdrawal = Selectable<WithdrawalsTable>;
export type Sweep = Selectable<SweepsTable>;
export type TreasuryInbound = Selectable<TreasuryInboundsTable>;
export type Job = Selectable<JobsTable>;
export type NewJob = Insertable<JobsTable>;
export type WithdrawalUpdate = Updateable<WithdrawalsTable>;
