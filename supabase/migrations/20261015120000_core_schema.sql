-- =============================================================================
-- Базовая схема: токены, пользователи, кошельки.
--
-- Все таблицы приложения живут в схеме app: PostgREST Supabase публикует только public/graphql_public,
-- так что таблицы недоступны через автогенерируемый REST API (см. ADR-0004 и миграцию security).
-- =============================================================================

create schema if not exists app;

-- Триггерная функция для updated_at.
create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Токены (allowlist). Всё, что приходит с другим tokenId, игнорируется — защита от спам-токенов:
-- у Circle нет флага «спам», а на адрес может прийти любой ERC-20.
-- -----------------------------------------------------------------------------
create table app.tokens (
  symbol           text primary key,
  blockchain       text        not null,
  circle_token_id  uuid        not null unique,
  contract_address text        not null,
  decimals         smallint    not null check (decimals between 0 and 36),
  is_enabled       boolean     not null default true,
  created_at       timestamptz not null default now(),
  constraint tokens_contract_address_lowercase check (contract_address = lower(contract_address))
);

comment on table app.tokens is 'Allowlist токенов. circle_token_id — глобальные UUID токенов Circle (стабильны между аккаунтами).';

insert into app.tokens (symbol, blockchain, circle_token_id, contract_address, decimals) values
  ('USDC', 'BASE-SEPOLIA', 'bdf128b4-827b-5267-8f9e-243694989b5f', '0x036cbd53842c5426634e7929541ec2318f3dcf7e', 6),
  ('EURC', 'BASE-SEPOLIA', '5b1ba740-7bb7-5695-bd2b-09243ce0f079', '0x808456652fdb597867f38412077a9182bf77359f', 6);

-- -----------------------------------------------------------------------------
-- Пользователи
-- -----------------------------------------------------------------------------
create table app.users (
  id         uuid primary key default gen_random_uuid(),
  name       text        not null check (char_length(name) between 1 and 100),
  created_at timestamptz not null default now()
);

create index users_created_at_idx on app.users (created_at desc, id desc);

-- -----------------------------------------------------------------------------
-- Кошельки Circle.
-- DEPOSIT — у каждого пользователя свой (только принимает пополнения),
-- TREASURY — один общий hot wallet, из которого идут все выводы (omnibus, ADR-0001).
-- Кошелёк создаётся асинхронно (задача wallet.create): сначала строка PENDING с заранее
-- сгенерированным circle_idempotency_key — ретраи создания в Circle не создадут второй кошелёк.
-- -----------------------------------------------------------------------------
create table app.wallets (
  id                     uuid primary key default gen_random_uuid(),
  kind                   text        not null check (kind in ('DEPOSIT', 'TREASURY')),
  user_id                uuid        references app.users (id),
  status                 text        not null default 'PENDING' check (status in ('PENDING', 'ACTIVE')),
  blockchain             text        not null,
  circle_wallet_id       text        unique,
  address                text        unique,
  circle_idempotency_key uuid        not null unique default gen_random_uuid(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint wallets_user_matches_kind check ((kind = 'DEPOSIT') = (user_id is not null)),
  constraint wallets_active_has_circle_data check (status <> 'ACTIVE' or (circle_wallet_id is not null and address is not null)),
  constraint wallets_address_lowercase check (address = lower(address))
);

create unique index wallets_one_deposit_per_user on app.wallets (user_id) where kind = 'DEPOSIT';
create unique index wallets_single_treasury on app.wallets (kind) where kind = 'TREASURY';

create trigger wallets_touch_updated_at before update on app.wallets
  for each row execute function app.touch_updated_at();
