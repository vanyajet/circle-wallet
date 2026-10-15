-- =============================================================================
-- Инфраструктура надёжности: inbox вебхуков, очередь задач, курсоры reconciliation,
-- результаты сверки балансов и NOTIFY-триггеры для SSE (ADR-0005, ADR-0006, ADR-0008).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Inbox вебхуков: событие сначала надёжно сохраняется (dedupe по notification_id — Circle присылает
-- один и тот же notificationId при повторной доставке), обрабатывается потом задачей webhook.process.
-- Сырой payload хранится для аудита и повторного применения.
-- -----------------------------------------------------------------------------
create table app.webhook_events (
  notification_id   uuid primary key,
  notification_type text        not null,
  subscription_id   text,
  payload           jsonb       not null,
  received_at       timestamptz not null default now(),
  processed_at      timestamptz,
  result            text
);

-- -----------------------------------------------------------------------------
-- Очередь задач (своя, на Postgres).
--   PENDING — ждёт run_at; RUNNING — захвачена воркером до locked_until (lease); DONE; DEAD — исчерпаны попытки.
-- Задача с истёкшим lease считается брошенной (воркер умер) и захватывается снова.
-- dedupe_key: не больше одной ОЖИДАЮЩЕЙ задачи с таким ключом (RUNNING не учитываем намеренно: новое событие,
-- пришедшее во время выполнения, должно получить свой запуск, а не потеряться).
-- -----------------------------------------------------------------------------
create table app.jobs (
  id           bigint generated always as identity primary key,
  kind         text        not null,
  payload      jsonb       not null default '{}'::jsonb,
  status       text        not null default 'PENDING' check (status in ('PENDING', 'RUNNING', 'DONE', 'DEAD')),
  attempts     int         not null default 0,
  max_attempts int         not null default 12 check (max_attempts > 0),
  run_at       timestamptz not null default now(),
  locked_by    text,
  locked_until timestamptz,
  dedupe_key   text,
  last_error   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  finished_at  timestamptz
);

create unique index jobs_dedupe_pending on app.jobs (dedupe_key) where status = 'PENDING';
create index jobs_claimable_idx on app.jobs (run_at) where status = 'PENDING';
create index jobs_lease_idx on app.jobs (locked_until) where status = 'RUNNING';
create index jobs_dead_idx on app.jobs (updated_at desc) where status = 'DEAD';

create trigger jobs_touch_updated_at before update on app.jobs
  for each row execute function app.touch_updated_at();

-- Постановка задачи; при совпадении dedupe_key с уже ожидающей задачей ничего не делает и возвращает null.
-- Вызывается в той же транзакции, что и бизнес-изменение (transactional outbox), а также из pg_cron.
create or replace function app.enqueue_job(
  p_kind         text,
  p_payload      jsonb       default '{}'::jsonb,
  p_dedupe_key   text        default null,
  p_run_at       timestamptz default now(),
  p_max_attempts int         default 12
) returns bigint
language plpgsql as $$
declare
  v_id bigint;
begin
  insert into app.jobs (kind, payload, dedupe_key, run_at, max_attempts)
  values (p_kind, coalesce(p_payload, '{}'::jsonb), p_dedupe_key, p_run_at, p_max_attempts)
  on conflict (dedupe_key) where status = 'PENDING' do nothing
  returning id into v_id;
  return v_id;
end;
$$;

-- Будим воркеры: NOTIFY доставляется только после commit, так что воркер не увидит задачу раньше, чем она видна в БД.
create or replace function app.notify_job_enqueued() returns trigger
language plpgsql as $$
begin
  perform pg_notify('app_jobs', new.kind);
  return null;
end;
$$;

create trigger jobs_notify_enqueued after insert on app.jobs
  for each row execute function app.notify_job_enqueued();

-- -----------------------------------------------------------------------------
-- Курсоры reconciliation (например, до какого момента просканированы входящие транзакции).
-- -----------------------------------------------------------------------------
create table app.sync_cursors (
  name       text primary key,
  cursor     timestamptz not null,
  updated_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Последний результат сверки CUSTODY леджера с on-chain балансом кошелька (reconcile.balances).
-- -----------------------------------------------------------------------------
create table app.balance_checks (
  wallet_id      uuid           not null references app.wallets (id),
  token          text           not null references app.tokens (symbol),
  ledger_custody numeric(78, 0) not null,
  on_chain       numeric(78, 0) not null,
  checked_at     timestamptz    not null default now(),
  primary key (wallet_id, token)
);

-- -----------------------------------------------------------------------------
-- Real-time: любое изменение, видимое пользователю, публикует сигнал в канал app_events.
-- Payload — только userId (лимит NOTIFY 8000 байт; данные клиент перечитывает по REST).
-- userId = null — изменение уровня treasury/ops. Одинаковые сигналы в одной транзакции Postgres схлопывает.
-- -----------------------------------------------------------------------------
create or replace function app.notify_app_event() returns trigger
language plpgsql as $$
declare
  v_row     jsonb := to_jsonb(coalesce(new, old));
  v_user_id text  := v_row ->> 'user_id';
begin
  perform pg_notify('app_events', json_build_object('userId', v_user_id)::text);
  return null;
end;
$$;

create trigger users_notify after insert on app.users
  for each row execute function app.notify_app_event();
create trigger wallets_notify after insert or update on app.wallets
  for each row execute function app.notify_app_event();
create trigger deposits_notify after insert or update on app.deposits
  for each row execute function app.notify_app_event();
create trigger withdrawals_notify after insert or update on app.withdrawals
  for each row execute function app.notify_app_event();
create trigger ledger_accounts_notify after insert or update on app.ledger_accounts
  for each row execute function app.notify_app_event();
create trigger sweeps_notify after insert or update on app.sweeps
  for each row execute function app.notify_app_event();
create trigger treasury_inbounds_notify after insert or update on app.treasury_inbounds
  for each row execute function app.notify_app_event();
