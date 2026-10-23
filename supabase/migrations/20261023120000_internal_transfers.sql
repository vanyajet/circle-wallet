-- =============================================================================
-- Внутренние переводы между пользователями по UID (ADR-0010).
--
-- Off-chain: при omnibus средства пользователей лежат на кошельках сервиса, а принадлежность определяет
-- только леджер. Поэтому перевод — одна проводка INTERNAL_TRANSFER (USER_AVAILABLE отправителя →
-- USER_AVAILABLE получателя) в одной транзакции с записью перевода. Circle и блокчейн не участвуют,
-- CUSTODY не меняется, глобальное тождество леджера сохраняется само.
-- UID получателя — его id пользователя (app.users.id).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Новый вид проводки. Имя constraint'а Postgres сгенерировал из inline CHECK колонки kind;
-- без IF EXISTS: если имя другое, миграция должна упасть, а не молча оставить старый CHECK.
-- -----------------------------------------------------------------------------
alter table app.ledger_transactions drop constraint ledger_transactions_kind_check;
alter table app.ledger_transactions add constraint ledger_transactions_kind_check check (kind in (
  'DEPOSIT_CREDIT', 'WITHDRAWAL_HOLD', 'WITHDRAWAL_SETTLE', 'WITHDRAWAL_RELEASE',
  'SWEEP_SETTLE', 'HOUSE_FUNDING', 'INTERNAL_TRANSFER'));

-- -----------------------------------------------------------------------------
-- Переводы.
-- Перевод атомарен: строка появляется в той же транзакции, что и проводка, сразу в COMPLETED.
-- Других статусов CHECK не допускает: строка «PENDING без проводки» — состояние, которое не обрабатывает
-- ни один код. Двухфазная схема (HOLD → проверки лимитов/AML → SETTLE | RELEASE) расширит CHECK на
-- PENDING/FAILED; API и история уже несут status, так что контракт не изменится.
-- idempotency_key + request_hash — идемпотентность клиентского POST, как у выводов (ADR-0009).
-- -----------------------------------------------------------------------------
create table app.internal_transfers (
  id                uuid primary key default gen_random_uuid(),
  sender_user_id    uuid           not null references app.users (id),
  recipient_user_id uuid           not null references app.users (id),
  token             text           not null references app.tokens (symbol),
  amount            numeric(78, 0) not null check (amount > 0),
  status            text           not null default 'COMPLETED' check (status = 'COMPLETED'),
  idempotency_key   uuid           not null,
  request_hash      text           not null,
  created_at        timestamptz    not null default now(),
  completed_at      timestamptz    not null default now(),
  constraint internal_transfers_idempotency unique (sender_user_id, idempotency_key),
  -- Перевод самому себе бессмыслен; заодно гарантирует, что перевод попадает в историю пользователя один раз.
  constraint internal_transfers_not_self check (sender_user_id <> recipient_user_id)
);

-- История пользователя читает переводы с обеих сторон: исходящие и входящие (keyset по created_at, id).
create index internal_transfers_sender_history_idx on app.internal_transfers (sender_user_id, created_at desc, id desc);
create index internal_transfers_recipient_history_idx on app.internal_transfers (recipient_user_id, created_at desc, id desc);

-- -----------------------------------------------------------------------------
-- Real-time. Общий app.notify_app_event читает колонку user_id — у перевода её нет, он отправил бы
-- userId = null (сигнал уровня ops), и SSE-стримы пользователей его не получили бы.
-- Перевод касается двух пользователей — сигналим обоим.
-- -----------------------------------------------------------------------------
create or replace function app.notify_internal_transfer_event() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and app.is_technical_update(to_jsonb(old), to_jsonb(new)) then
    return null;
  end if;
  perform pg_notify('app_events', json_build_object('userId', new.sender_user_id)::text);
  perform pg_notify('app_events', json_build_object('userId', new.recipient_user_id)::text);
  return null;
end;
$$;

create trigger internal_transfers_notify after insert or update on app.internal_transfers
  for each row execute function app.notify_internal_transfer_event();

-- -----------------------------------------------------------------------------
-- Защита от доступа через Supabase API — как в миграции security: цикл там прошёл по таблицам,
-- существовавшим на тот момент, новую таблицу закрываем явно.
-- -----------------------------------------------------------------------------
alter table app.internal_transfers enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on app.internal_transfers from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on app.internal_transfers from authenticated;
  end if;
end;
$$;

revoke execute on function app.notify_internal_transfer_event() from public;
