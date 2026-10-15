-- =============================================================================
-- Операции, привязанные к транзакциям Circle: депозиты, выводы, sweep'ы и входящие на treasury.
--
-- У каждой операции:
--   status       — наш статус (что видит пользователь и от чего зависят проводки);
--   circle_state — сырое состояние Circle (INITIATED/QUEUED/.../COMPLETE/FAILED), монотонно растёт по рангу.
-- circle_transaction_id уникален в пределах таблицы: у внутреннего перевода (sweep, вывод на deposit-адрес
-- другого пользователя) OUTBOUND- и INBOUND-ноги могут иметь один id, но живут в разных таблицах.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Депозиты: входящие на deposit wallet пользователя.
-- PENDING (Circle CONFIRMED и ниже) → COMPLETED (Circle COMPLETE, проводка DEPOSIT_CREDIT) | FAILED.
-- -----------------------------------------------------------------------------
create table app.deposits (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid           not null references app.users (id),
  wallet_id             uuid           not null references app.wallets (id),
  token                 text           not null references app.tokens (symbol),
  amount                numeric(78, 0) not null check (amount > 0),
  status                text           not null check (status in ('PENDING', 'COMPLETED', 'FAILED')),
  circle_transaction_id text           not null unique,
  circle_state          text           not null,
  tx_hash               text,
  source_address        text,
  error_reason          text,
  error_details         text,
  created_at            timestamptz    not null default now(),
  updated_at            timestamptz    not null default now(),
  completed_at          timestamptz
);

create index deposits_user_history_idx on app.deposits (user_id, created_at desc, id desc);
create index deposits_pending_idx on app.deposits (updated_at) where status = 'PENDING';

create trigger deposits_touch_updated_at before update on app.deposits
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Выводы (всегда из treasury).
-- PENDING     — средства пользователя в hold, ждём worker'а / ликвидности treasury (awaiting_liquidity);
-- SUBMITTING  — ликвидность treasury зарезервирована, запрос в Circle отправляется (исход может быть неизвестен);
-- SUBMITTED   — Circle принял перевод (есть circle_transaction_id);
-- COMPLETED   — Circle COMPLETE (проводка WITHDRAWAL_SETTLE);
-- FAILED      — отказ / FAILED / DENIED / CANCELLED (проводка WITHDRAWAL_RELEASE — деньги вернулись в available).
-- idempotency_key + request_hash — идемпотентность клиентского POST (ADR-0009).
-- -----------------------------------------------------------------------------
create table app.withdrawals (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid           not null references app.users (id),
  token                 text           not null references app.tokens (symbol),
  amount                numeric(78, 0) not null check (amount > 0),
  destination_address   text           not null check (destination_address = lower(destination_address)),
  status                text           not null default 'PENDING'
                          check (status in ('PENDING', 'SUBMITTING', 'SUBMITTED', 'COMPLETED', 'FAILED')),
  awaiting_liquidity    boolean        not null default false,
  idempotency_key       uuid           not null,
  request_hash          text           not null,
  circle_transaction_id text           unique,
  circle_state          text,
  tx_hash               text,
  error_reason          text,
  error_details         text,
  created_at            timestamptz    not null default now(),
  updated_at            timestamptz    not null default now(),
  submitted_at          timestamptz,
  completed_at          timestamptz,
  constraint withdrawals_idempotency unique (user_id, idempotency_key),
  constraint withdrawals_submitted_has_circle_id check (status not in ('SUBMITTED', 'COMPLETED') or circle_transaction_id is not null)
);

create index withdrawals_user_history_idx on app.withdrawals (user_id, created_at desc, id desc);
create index withdrawals_in_flight_idx on app.withdrawals (token, status) where status in ('PENDING', 'SUBMITTING', 'SUBMITTED');

create trigger withdrawals_touch_updated_at before update on app.withdrawals
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Sweep: перевод с deposit wallet на treasury.
-- Сумма фиксируется при создании (из CUSTODY кошелька). Один активный sweep на (кошелёк, токен).
-- -----------------------------------------------------------------------------
create table app.sweeps (
  id                    uuid primary key default gen_random_uuid(),
  wallet_id             uuid           not null references app.wallets (id),
  token                 text           not null references app.tokens (symbol),
  amount                numeric(78, 0) not null check (amount > 0),
  status                text           not null default 'PENDING'
                          check (status in ('PENDING', 'SUBMITTED', 'COMPLETED', 'FAILED')),
  circle_transaction_id text           unique,
  circle_state          text,
  tx_hash               text,
  error_reason          text,
  error_details         text,
  created_at            timestamptz    not null default now(),
  updated_at            timestamptz    not null default now(),
  submitted_at          timestamptz,
  completed_at          timestamptz
);

create unique index sweeps_one_active_per_wallet_token on app.sweeps (wallet_id, token)
  where status in ('PENDING', 'SUBMITTED');
create index sweeps_tx_hash_idx on app.sweeps (lower(tx_hash)) where tx_hash is not null;

create trigger sweeps_touch_updated_at before update on app.sweeps
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Входящие на treasury и их классификация (design-doc §4):
--   SWEEP         — вторая нога нашего sweep (проводок нет: sweep проводится по своей outbound-транзакции);
--   HOUSE_FUNDING — стороннее пополнение (house float): проводка HOUSE_FUNDING;
--   UNCLASSIFIED  — пришло с нашего deposit-адреса, но sweep не найден за таймаут — ручной разбор, без проводок;
--   FAILED        — транзакция не состоялась;
--   PENDING       — ещё не классифицировано.
-- -----------------------------------------------------------------------------
create table app.treasury_inbounds (
  id                    uuid primary key default gen_random_uuid(),
  wallet_id             uuid           not null references app.wallets (id),
  token                 text           not null references app.tokens (symbol),
  amount                numeric(78, 0) not null check (amount > 0),
  circle_transaction_id text           not null unique,
  circle_state          text           not null,
  tx_hash               text,
  source_address        text,
  classification        text           not null default 'PENDING'
                          check (classification in ('PENDING', 'SWEEP', 'HOUSE_FUNDING', 'UNCLASSIFIED', 'FAILED')),
  sweep_id              uuid           references app.sweeps (id),
  created_at            timestamptz    not null default now(),
  updated_at            timestamptz    not null default now(),
  classified_at         timestamptz
);

create trigger treasury_inbounds_touch_updated_at before update on app.treasury_inbounds
  for each row execute function app.touch_updated_at();
