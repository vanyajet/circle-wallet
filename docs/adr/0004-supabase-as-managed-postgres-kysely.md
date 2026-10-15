# ADR-0004: Supabase как managed Postgres, прямое подключение и Kysely

**Статус:** Accepted

## Контекст
ТЗ требует базу в Supabase. Нам нужны многошаговые транзакции из кода (`SELECT … FOR UPDATE`),
очередь на `FOR UPDATE SKIP LOCKED` в одной транзакции с бизнес-изменением, `LISTEN/NOTIFY`
для SSE и пробуждения воркера, точный `numeric`.

## Решение
- Supabase используется как **managed Postgres**, плюс CLI для миграций (`supabase/migrations`),
  Dashboard и pg_cron.
- Бэкенд подключается **напрямую** драйвером `pg` через **Supavisor session pooler** (порт 5432):
  он работает по IPv4 и поддерживает `LISTEN/NOTIFY` и prepared statements. Direct connection на
  free tier доступен только по IPv6, а transaction mode (6543) не поддерживает `LISTEN/NOTIFY`.
- Запросы пишутся на **Kysely**: типизированный query builder, не ORM, SQL остаётся виден.
- Таблицы лежат в схеме `app`, которую PostgREST не публикует; RLS включён; у `anon`/`authenticated`
  нет прав.

## Альтернативы

| Вариант | Плюсы | Минусы |
|---|---|---|
| `supabase-js` + `rpc()` (plpgsql-функции) | Используем Supabase «по назначению»; работает по HTTP везде | Каждый вызов — отдельная HTTP-транзакция: атомарные сценарии только в plpgsql. Нет `LISTEN`. PostgREST отдаёт `numeric` как JSON number, и точность теряется после 2^53 (1 ETH = 10¹⁸ wei). Логика разделена между SQL и TS |
| **Прямое подключение + Kysely** (выбрано) | Транзакции в TS, `SKIP LOCKED`, `LISTEN/NOTIFY`, `numeric` строкой → `bigint` | Supabase — «просто Postgres»; нужно следить за режимом pooler'а и бюджетом соединений |
| Prisma / Drizzle ORM | Миграции и схема в коде | Мы хотим SQL-миграции в формате Supabase CLI; Prisma плохо работает с `numeric(78,0)` и `SKIP LOCKED` |
| Сырой SQL (`pg`/`postgres.js`) | Максимум контроля | Нет типизации результатов |

## Последствия
- В session mode каждое клиентское соединение занимает серверное, а пул free tier небольшой.
  Поэтому пул каждого процесса ограничен (`DB_POOL_MAX=3`), плюс одно `LISTEN`-соединение.
- Денежные инварианты продублированы в БД (constraints и триггеры): защита даже от бага в коде.
- Проект free tier засыпает после 7 дней неактивности (вместе с pg_cron).
