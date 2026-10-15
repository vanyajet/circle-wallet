-- =============================================================================
-- pg_cron — планировщик, а не исполнитель (ADR-0005).
--
-- Каждое расписание только ставит задачу в app.jobs (с dedupe_key — не больше одной ожидающей),
-- а выполняют её воркеры: им нужны API key и entity secret, которых в БД нет.
-- Плюсы: один планировщик на любое число воркеров без leader election; расписание переживает
-- рестарты приложения; история запусков — в cron.job_run_details.
-- На Postgres без pg_cron (интеграционные тесты) блок пропускается.
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron недоступен — периодические задачи не запланированы';
    return;
  end if;

  create extension if not exists pg_cron;

  -- cron.schedule с тем же именем обновляет существующую задачу — миграция идемпотентна.
  perform cron.schedule(
    'app-reconcile-pending', '30 seconds',
    $cmd$select app.enqueue_job('reconcile.pending', '{}'::jsonb, 'reconcile.pending')$cmd$
  );
  perform cron.schedule(
    'app-reconcile-inbound', '* * * * *',
    $cmd$select app.enqueue_job('reconcile.inbound', '{}'::jsonb, 'reconcile.inbound')$cmd$
  );
  perform cron.schedule(
    'app-reconcile-balances', '*/5 * * * *',
    $cmd$select app.enqueue_job('reconcile.balances', '{}'::jsonb, 'reconcile.balances')$cmd$
  );
  -- Гигиена: завершённые задачи старше 7 дней и история запусков pg_cron (при расписании раз в 30 с она растёт быстро).
  perform cron.schedule(
    'app-cleanup', '17 3 * * *',
    $cmd$
      delete from app.jobs where status = 'DONE' and finished_at < now() - interval '7 days';
      delete from cron.job_run_details where end_time < now() - interval '3 days';
    $cmd$
  );
end;
$$;
