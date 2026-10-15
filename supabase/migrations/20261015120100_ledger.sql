-- =============================================================================
-- Double-entry ledger (ADR-0003).
--
-- Инварианты обеспечиваются базой, а не только кодом приложения:
--   1. каждая проводка сбалансирована: Σ debit = Σ credit (по каждому токену) — проверяется на commit;
--   2. журнал append-only: UPDATE/DELETE записей запрещены;
--   3. exactly-once: UNIQUE (kind, reference_id) — одно событие нельзя провести дважды;
--   4. балансы неотрицательны: CHECK (balance >= 0) — последняя линия защиты от double-spend.
-- Суммы — numeric(78,0) в минимальных единицах токена (78 цифр = uint256).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Счета. balance — кешированный баланс в «естественном» знаке счёта (положительный = есть средства),
-- обновляется триггером на вставку записи в той же транзакции.
--   USER_AVAILABLE, USER_HELD — обязательства перед пользователем (нормальная сторона CREDIT);
--   CUSTODY                   — сколько токена лежит на конкретном кошельке (актив, DEBIT);
--   HOUSE                     — собственные средства сервиса на treasury (equity, CREDIT).
-- -----------------------------------------------------------------------------
create table app.ledger_accounts (
  id         uuid primary key default gen_random_uuid(),
  type       text           not null check (type in ('USER_AVAILABLE', 'USER_HELD', 'CUSTODY', 'HOUSE')),
  token      text           not null references app.tokens (symbol),
  user_id    uuid           references app.users (id),
  wallet_id  uuid           references app.wallets (id),
  balance    numeric(78, 0) not null default 0,
  created_at timestamptz    not null default now(),
  updated_at timestamptz    not null default now(),
  constraint ledger_accounts_balance_non_negative check (balance >= 0),
  constraint ledger_accounts_owner check (
    (type in ('USER_AVAILABLE', 'USER_HELD') and user_id is not null and wallet_id is null)
    or (type = 'CUSTODY' and wallet_id is not null and user_id is null)
    or (type = 'HOUSE' and user_id is null and wallet_id is null)
  ),
  constraint ledger_accounts_unique unique nulls not distinct (type, token, user_id, wallet_id)
);

create index ledger_accounts_user_idx on app.ledger_accounts (user_id) where user_id is not null;
create index ledger_accounts_wallet_idx on app.ledger_accounts (wallet_id) where wallet_id is not null;

-- -----------------------------------------------------------------------------
-- Проводки и их записи.
-- reference_id — id бизнес-сущности (deposit / withdrawal / sweep / treasury_inbound),
-- вместе с kind образует ключ exactly-once.
-- -----------------------------------------------------------------------------
create table app.ledger_transactions (
  id           uuid primary key default gen_random_uuid(),
  kind         text        not null check (kind in (
                 'DEPOSIT_CREDIT', 'WITHDRAWAL_HOLD', 'WITHDRAWAL_SETTLE', 'WITHDRAWAL_RELEASE',
                 'SWEEP_SETTLE', 'HOUSE_FUNDING')),
  reference_id uuid        not null,
  description  text,
  created_at   timestamptz not null default now(),
  constraint ledger_transactions_exactly_once unique (kind, reference_id)
);

create table app.ledger_entries (
  id             bigint generated always as identity primary key,
  transaction_id uuid           not null references app.ledger_transactions (id),
  account_id     uuid           not null references app.ledger_accounts (id),
  direction      text           not null check (direction in ('DEBIT', 'CREDIT')),
  amount         numeric(78, 0) not null check (amount > 0),
  created_at     timestamptz    not null default now()
);

create index ledger_entries_account_idx on app.ledger_entries (account_id, id);
create index ledger_entries_transaction_idx on app.ledger_entries (transaction_id);

-- -----------------------------------------------------------------------------
-- Кешированный баланс: запись увеличивает баланс, если её сторона совпадает с нормальной стороной счёта,
-- и уменьшает иначе. CHECK (balance >= 0) отклонит запись, уводящую счёт в минус.
-- -----------------------------------------------------------------------------
create or replace function app.ledger_apply_entry() returns trigger
language plpgsql as $$
begin
  update app.ledger_accounts a
     set balance = a.balance + case
                                 when (a.type = 'CUSTODY') = (new.direction = 'DEBIT') then new.amount
                                 else -new.amount
                               end,
         updated_at = now()
   where a.id = new.account_id;
  if not found then
    raise exception 'ledger account % not found', new.account_id;
  end if;
  return new;
end;
$$;

create trigger ledger_entries_apply after insert on app.ledger_entries
  for each row execute function app.ledger_apply_entry();

-- -----------------------------------------------------------------------------
-- Баланс проводки проверяется отложенно (на commit): записи вставляются по одной,
-- а сбалансированной проводка должна быть только целиком. Проверка по каждому токену отдельно.
-- -----------------------------------------------------------------------------
create or replace function app.ledger_assert_balanced() returns trigger
language plpgsql as $$
declare
  v_transaction_id uuid;
  v_entries        int;
  v_unbalanced     text;
begin
  -- Триггер висит на двух таблицах: у записи id проводки в transaction_id, у самой проводки — в id.
  if tg_table_name = 'ledger_entries' then
    v_transaction_id := new.transaction_id;
  else
    v_transaction_id := new.id;
  end if;

  select count(*) into v_entries from app.ledger_entries e where e.transaction_id = v_transaction_id;
  if v_entries < 2 then
    raise exception 'ledger transaction % must have at least 2 entries, has %', v_transaction_id, v_entries;
  end if;

  select string_agg(token || ':' || diff::text, ', ') into v_unbalanced
    from (
      select a.token, sum(case when e.direction = 'DEBIT' then e.amount else -e.amount end) as diff
        from app.ledger_entries e
        join app.ledger_accounts a on a.id = e.account_id
       where e.transaction_id = v_transaction_id
       group by a.token
    ) t
   where diff <> 0;
  if v_unbalanced is not null then
    raise exception 'ledger transaction % is unbalanced (%)', v_transaction_id, v_unbalanced;
  end if;
  return null;
end;
$$;

create constraint trigger ledger_entries_balanced
  after insert on app.ledger_entries
  deferrable initially deferred
  for each row execute function app.ledger_assert_balanced();

-- Проводка без записей тоже недопустима: проверяем и на вставку самой проводки.
create constraint trigger ledger_transactions_have_entries
  after insert on app.ledger_transactions
  deferrable initially deferred
  for each row execute function app.ledger_assert_balanced();

-- -----------------------------------------------------------------------------
-- Append-only: историю нельзя переписать. Ошибки исправляются только новыми (сторнирующими) проводками.
-- -----------------------------------------------------------------------------
create or replace function app.ledger_forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'ledger is append-only: % on % is not allowed', tg_op, tg_table_name;
end;
$$;

create trigger ledger_entries_append_only before update or delete on app.ledger_entries
  for each row execute function app.ledger_forbid_mutation();
create trigger ledger_transactions_append_only before update or delete on app.ledger_transactions
  for each row execute function app.ledger_forbid_mutation();
