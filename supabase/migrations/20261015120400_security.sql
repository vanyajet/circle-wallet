-- =============================================================================
-- Защита данных от доступа через Supabase API (ADR-0004).
--
-- Бэкенд подключается к Postgres напрямую ролью-владельцем таблиц (postgres) — на неё RLS не действует.
-- Роли anon/authenticated (ключи которых Supabase раздаёт для фронтенда) не должны видеть ничего:
--   1) схема app не публикуется PostgREST (exposed schemas по умолчанию: public, graphql_public);
--   2) RLS включён без политик — даже при случайной публикации схемы строк не видно;
--   3) права у anon/authenticated отозваны явно.
-- Блоки с проверкой ролей нужны, чтобы миграции работали и на «голом» Postgres (интеграционные тесты).
-- =============================================================================

do $$
declare
  t record;
begin
  for t in select tablename from pg_tables where schemaname = 'app' loop
    execute format('alter table app.%I enable row level security', t.tablename);
  end loop;

  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on schema app from anon;
    revoke all on all tables in schema app from anon;
    revoke all on all sequences in schema app from anon;
    revoke all on all functions in schema app from anon;
  end if;

  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on schema app from authenticated;
    revoke all on all tables in schema app from authenticated;
    revoke all on all sequences in schema app from authenticated;
    revoke all on all functions in schema app from authenticated;
  end if;
end;
$$;

-- Функции создаются с EXECUTE для PUBLIC по умолчанию — отзываем, чтобы enqueue_job нельзя было дёрнуть извне.
revoke execute on all functions in schema app from public;
