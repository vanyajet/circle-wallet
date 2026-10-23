# Architecture Decision Records

Каждый ADR фиксирует одно решение: контекст, принятый вариант, рассмотренные альтернативы и последствия.

| # | Решение |
|---|---|
| [0001](./0001-omnibus-custody-model.md) | Omnibus: treasury, deposit-адреса и sweep |
| [0002](./0002-sca-wallets-gas-station.md) | SCA-кошельки и Gas Station вместо EOA |
| [0003](./0003-double-entry-ledger.md) | Double-entry ledger, кешированные балансы, `numeric(78,0)` |
| [0004](./0004-supabase-as-managed-postgres-kysely.md) | Supabase как managed Postgres, прямое подключение и Kysely |
| [0005](./0005-postgres-job-queue-separate-worker.md) | Очередь задач в Postgres, отдельный worker, pg_cron как планировщик |
| [0006](./0006-webhook-inbox-and-verification.md) | Inbox для вебхуков и проверка подписи |
| [0007](./0007-own-circle-http-client.md) | Собственный HTTP-клиент Circle вместо SDK |
| [0008](./0008-sse-over-listen-notify.md) | Real-time через SSE поверх LISTEN/NOTIFY |
| [0009](./0009-idempotency-strategy.md) | Сквозная стратегия идемпотентности |
| [0010](./0010-internal-transfers-off-chain.md) | Переводы по UID — off-chain проводка в леджере |
