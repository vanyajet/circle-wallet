-- =============================================================================
-- Учёт сверки: когда операцию последний раз проверяли в Circle.
--
-- Без этого reconcile брал «самые старые по updated_at» строки: операции, у которых проверка ничего не меняет,
-- навсегда оставались в голове выборки, и до остальных очередь не доходила (starvation).
-- Теперь выборка идёт по last_reconciled_at (nulls first) — каждая проверка отправляет строку в конец очереди.
-- =============================================================================

alter table app.withdrawals add column last_reconciled_at timestamptz;
alter table app.sweeps add column last_reconciled_at timestamptz;
alter table app.deposits add column last_reconciled_at timestamptz;
alter table app.treasury_inbounds add column last_reconciled_at timestamptz;

-- Техническая отметка проверки — не изменение данных: не двигаем updated_at и не шлём SSE-сигнал.
create or replace function app.is_technical_update(p_old jsonb, p_new jsonb) returns boolean
language sql immutable as $$
  select (p_old - 'updated_at' - 'last_reconciled_at') = (p_new - 'updated_at' - 'last_reconciled_at');
$$;

create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  if app.is_technical_update(to_jsonb(old), to_jsonb(new)) then
    new.updated_at := old.updated_at;
  else
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create or replace function app.notify_app_event() returns trigger
language plpgsql as $$
declare
  v_row     jsonb := to_jsonb(coalesce(new, old));
  v_user_id text  := v_row ->> 'user_id';
begin
  if tg_op = 'UPDATE' and app.is_technical_update(to_jsonb(old), to_jsonb(new)) then
    return null;
  end if;
  perform pg_notify('app_events', json_build_object('userId', v_user_id)::text);
  return null;
end;
$$;

revoke execute on function app.is_technical_update(jsonb, jsonb) from public;

create index withdrawals_reconcile_idx on app.withdrawals (last_reconciled_at nulls first) where status = 'SUBMITTED';
create index sweeps_reconcile_idx on app.sweeps (last_reconciled_at nulls first) where status in ('PENDING', 'SUBMITTED');
create index deposits_reconcile_idx on app.deposits (last_reconciled_at nulls first) where status = 'PENDING';

-- -----------------------------------------------------------------------------
-- notificationId Circle документирует как UUID, но не-UUID значение не должно превращаться
-- в бесконечный цикл 503 (ошибка приведения типа на INSERT) — храним как текст.
-- -----------------------------------------------------------------------------
alter table app.webhook_events alter column notification_id type text;

-- -----------------------------------------------------------------------------
-- Периодические задачи: не ставим новую, пока предыдущая того же вида ещё ждёт или ВЫПОЛНЯЕТСЯ.
-- Иначе медленный прогон сверки (например, когда Circle тормозит) накладывается на следующий
-- и удваивает нагрузку на rate limit Circle именно тогда, когда ему и так плохо.
-- -----------------------------------------------------------------------------
create or replace function app.enqueue_periodic_job(p_kind text) returns bigint
language plpgsql as $$
begin
  if exists (select 1 from app.jobs where dedupe_key = p_kind and status in ('PENDING', 'RUNNING')) then
    return null;
  end if;
  return app.enqueue_job(p_kind, '{}'::jsonb, p_kind, now(), 3);
end;
$$;

revoke execute on function app.enqueue_periodic_job(text) from public;

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    return;
  end if;
  perform cron.schedule('app-reconcile-pending', '30 seconds', $cmd$select app.enqueue_periodic_job('reconcile.pending')$cmd$);
  perform cron.schedule('app-reconcile-inbound', '* * * * *', $cmd$select app.enqueue_periodic_job('reconcile.inbound')$cmd$);
  perform cron.schedule('app-reconcile-balances', '*/5 * * * *', $cmd$select app.enqueue_periodic_job('reconcile.balances')$cmd$);
end;
$$;
