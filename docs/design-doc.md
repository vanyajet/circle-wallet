# Design Doc: криптокошелёк на Circle Developer-Controlled Wallets

| | |
|---|---|
| Статус | Accepted, реализуется |
| Сеть | `BASE-SEPOLIA` (testnet) |
| Стек | Express + TypeScript, Supabase (Postgres), Next.js + Tailwind |
| Связанные документы | [ADR](./adr), [исследование Circle API](./research/circle-api-notes.md), [README](../README.md) |

---

## 1. Цели и границы

### Что делает система
1. Создаёт пользователей; у каждого свой **deposit-адрес** для пополнения.
2. Принимает пополнения (например, с [faucet.circle.com](https://faucet.circle.com)) и показывает их в истории.
3. Выводит средства на любой внешний адрес в пределах доступного баланса и доводит вывод до финального
   статуса: выполнен или не выполнен.
4. Показывает текущий баланс и историю операций со статусами в реальном времени.

### Принципы
- **Деньги не теряются и не удваиваются** ни при каких сбоях: падение процесса, дубли и потеря
  вебхуков, таймауты Circle, параллельные запросы.
- **Источник правды о балансах пользователей — наш леджер**, а не Circle. Circle исполняет переводы
  в блокчейне и сообщает о движении средств. Мы сверяем леджер с on-chain состоянием, но не
  подменяем им учёт.
- **Как в проде, в базовой версии.** Используем production-паттерны (omnibus, double-entry ledger,
  outbox/inbox, durable job queue, reconciliation), но без лишней инфраструктуры.

### Non-goals (сознательно вне scope)
- Аутентификация и авторизация пользователей (по ТЗ не нужны).
- Комиссии за вывод, лимиты, KYC/AML, AML-скоринг адресов.
- Mainnet, cold storage, multisig, пул hot wallets.
- Нативный ETH и произвольные ERC-20: поддерживаются только токены из allowlist (USDC, EURC).

---

## 2. Глоссарий

| Термин | Значение |
|---|---|
| **Treasury** (hot wallet) | Общий кошелёк сервиса. Из него идут все выводы. |
| **Deposit wallet** | Кошелёк конкретного пользователя: только принимает пополнения. |
| **Sweep** | Перевод средств с deposit wallet на treasury. |
| **Omnibus** | Модель хранения, при которой средства пользователей лежат на общем кошельке, а принадлежность определяет только леджер. |
| **House float** | Собственные средства сервиса на treasury. Обеспечивают ликвидность до завершения sweep. |
| **Custody** | Счёт леджера «сколько токена фактически лежит на конкретном кошельке». |
| **Hold** | Резерв средств пользователя под вывод, который ещё не завершён. |
| **SCA** | Smart Contract Account (ERC-4337). Газ за него оплачивает Circle Gas Station. |
| **Outbox / Inbox** | Паттерны надёжной доставки: задача ставится в одной транзакции с изменением; входящее событие сначала надёжно сохраняется, обрабатывается потом. |
| **Lease** | «Аренда» задачи воркером на ограниченное время. Если воркер умер, lease истекает и задачу берёт другой. |

---

## 3. Архитектура

```
                    REST + SSE                                    HTTPS (API key + entity secret)
   ┌─────────────┐ ───────────────▶ ┌──────────────────┐                ┌───────────────────────┐
   │ Next.js web │                  │ api (Express)    │ ◀── webhooks ──│ Circle W3S            │
   │ (браузер)   │ ◀─────────────── │ REST, SSE,       │                │ Developer-Controlled  │
   └─────────────┘   SSE invalidate │ webhook ingest   │                │ Wallets, BASE-SEPOLIA │
                                    └──┬───────────▲───┘                └──────────▲────────────┘
                                       │ SQL tx    │ LISTEN                        │
                                       ▼           │                               │
                          ┌──────────────────────────────────────┐                │
                          │ Postgres (Supabase)                  │                │
                          │ users, wallets, ledger, deposits,    │                │
                          │ withdrawals, sweeps, webhook_events, │                │
                          │ jobs (очередь), pg_cron (расписание) │                │
                          └───────────▲──────────────────────────┘                │
                                      │ SKIP LOCKED / NOTIFY                       │
                                      │                                            │
                               ┌──────┴─────────┐                                  │
                               │ worker         │ ─────────────────────────────────┘
                               │ (job handlers) │   create wallet / transfer / get tx
                               └────────────────┘
```

### Процессы

| Процесс | Ответственность | Чего НЕ делает |
|---|---|---|
| **api** | REST для фронта; приём вебхуков (проверка подписи → запись в inbox → `200`); SSE-стримы | Не ходит в Circle с мутациями; не выполняет долгую работу |
| **worker** | Выполняет задачи из очереди: создание кошельков, отправка выводов, sweep, обработка вебхуков, reconciliation | Не принимает HTTP-трафик |
| **Postgres** | Единственный источник правды: данные, леджер, очередь задач, inbox вебхуков; pg_cron ставит периодические задачи | Не вызывает Circle (секреты не хранятся в БД) |

Оба Node-процесса stateless. В памяти держатся только кеши публичных ключей Circle, которые
можно запросить заново. Любой процесс можно перезапустить в любой момент: состояние не теряется.
api и worker собираются из одной кодовой базы (`apps/backend`) с разными entrypoint'ами и
масштабируются независимо. Подробнее в [ADR-0005](./adr/0005-postgres-job-queue-separate-worker.md).

---

## 4. Модель хранения средств: omnibus

Подробнее в [ADR-0001](./adr/0001-omnibus-custody-model.md) и [ADR-0002](./adr/0002-sca-wallets-gas-station.md).

```
faucet / внешний адрес
        │  депозит
        ▼
 deposit wallet пользователя ──(депозит COMPLETE → зачисление в леджер)──▶ sweep ──▶ TREASURY ──▶ вывод на внешний адрес
                                                                                        ▲
                                                               house float (faucet) ────┘
```

- Все кошельки — **SCA** в одном wallet set: газ спонсирует Gas Station, нативный ETH не нужен.
  Deposit wallet создаётся с `refId = userId`.
- **Депозит** зачисляется пользователю, когда Circle сообщает `COMPLETE`. Состояние `CONFIRMED`
  показывается как «в обработке»: до `COMPLETE` возможен reorg (`FAILED_REORG`).
- **Sweep** запускается только после `COMPLETE` депозита и только если custody-баланс deposit wallet
  по токену не меньше порога `SWEEP_MIN_AMOUNT`. Как в проде: мелочь не сметаем, чтобы не тратить газ.
- **Выводы** идут только из treasury. Если ликвидности treasury не хватает (sweep ещё не завершён),
  вывод ждёт в статусе `PENDING` с флагом `awaiting_liquidity` и уходит, как только ликвидность появится.
- **House float**: treasury можно пополнить напрямую (например, с фаусета). Такое поступление
  проводится на equity-счёт `HOUSE` и сразу даёт ликвидность для выводов. В реальной жизни это
  аналог пополнения hot wallet из cold storage.

### Классификация входящих на treasury
На treasury приходят поступления двух видов: «вторая нога» нашего sweep и сторонние (house float).
Перепутать их нельзя: принятый за house funding sweep удвоит custody, а house funding, принятый
за sweep, занизит ликвидность. Поэтому:
1. Sweep проводится в леджере **по его собственной outbound-транзакции** (`COMPLETE`, поиск по
   `refId = sweep:<id>`), а не по входящему на treasury.
2. Входящее на treasury сопоставляется с sweep: по тому же Circle id (ноги внутреннего перевода
   могут его делить), по `refId = sweep:<id>` из REST-представления или по `txHash`. Если у
   несопоставленных sweep хэша ещё нет (у SCA `txHash` появляется только на `CONFIRMED`), worker
   запрашивает их актуальное состояние у Circle и повторяет попытку позже. Если детали входящего
   получить не удалось (Circle недоступен), решение откладывается, а не принимается вслепую.
3. Если источник — наш deposit-адрес, а sweep не найден, поступление **никогда** не уходит в house.
   Ждём, а после таймаута ставим `UNCLASSIFIED` (ручной разбор, без проводок).
4. Источник не наш (или неизвестен, а таймаут вышел) → `HOUSE_FUNDING`: дебет `custody:treasury`,
   кредит `house`.

При сомнении ошибаемся в безопасную сторону: учтённая ликвидность скорее меньше реальной, чем больше.

### Запрещённые адреса вывода
Нулевой адрес; адреса контрактов токенов (USDC-контракт в denylist Circle, перевод на него падает);
treasury (средства ушли бы в неклассифицированные); собственный deposit-адрес пользователя.
Вывод на deposit-адрес **другого** пользователя разрешён: он пройдёт on-chain и зачислится
получателю как депозит. Внутренний off-chain перевод — future work.

---

## 5. Леджер (double-entry)

Подробнее в [ADR-0003](./adr/0003-double-entry-ledger.md).

### Счета (`ledger_accounts`), отдельно по каждому токену

| Тип | Нормальная сторона | Смысл | Ключ |
|---|---|---|---|
| `USER_AVAILABLE` | credit (обязательство) | Сколько пользователь может вывести | user + token |
| `USER_HELD` | credit (обязательство) | Зарезервировано под выводы в процессе | user + token |
| `CUSTODY` | debit (актив) | Сколько токена лежит на конкретном кошельке | wallet + token |
| `HOUSE` | credit (equity) | Собственные средства сервиса | token |

### Проводки (`ledger_transactions` + `ledger_entries`)

| Событие (`kind`) | Дебет | Кредит |
|---|---|---|
| `DEPOSIT_CREDIT`: депозит `COMPLETE` | `CUSTODY(deposit wallet)` | `USER_AVAILABLE` |
| `WITHDRAWAL_HOLD`: вывод создан | `USER_AVAILABLE` | `USER_HELD` |
| `WITHDRAWAL_SETTLE`: вывод `COMPLETE` | `USER_HELD` | `CUSTODY(treasury)` |
| `WITHDRAWAL_RELEASE`: вывод не выполнен | `USER_HELD` | `USER_AVAILABLE` |
| `SWEEP_SETTLE`: sweep `COMPLETE` | `CUSTODY(treasury)` | `CUSTODY(deposit wallet)` |
| `HOUSE_FUNDING`: стороннее поступление на treasury | `CUSTODY(treasury)` | `HOUSE` |

### Инварианты (обеспечиваются базой данных, а не только кодом)
1. **Баланс каждой проводки:** Σ debit = Σ credit. Это deferred constraint trigger, он проверяется
   на commit.
2. **Append-only:** `UPDATE`/`DELETE` записей леджера запрещены триггером. Ошибки исправляются
   только новыми (сторнирующими) проводками.
3. **Exactly-once:** `UNIQUE (kind, reference_id)`. Например, депозит физически нельзя зачислить
   дважды, сколько бы раз ни пришёл вебхук.
4. **Неотрицательные балансы:** `CHECK (balance >= 0)` на всех счетах. Это последняя линия защиты
   от double-spend.
5. **Глобальное тождество** по каждому токену: Σ `CUSTODY` = Σ `USER_AVAILABLE` + Σ `USER_HELD` + Σ `HOUSE`.
   Проверяется на ops-странице.

### Кешированный баланс
`ledger_accounts.balance` обновляется триггером на вставку `ledger_entries` **в той же транзакции**.
Он не может разойтись с суммой записей. Чтение баланса — O(1). Записи вставляются в порядке
`account_id`, чтобы параллельные проводки не ловили deadlock.

**Снапшоты (future work):** таблица `(account_id, last_entry_id, balance)`, которую периодически
пишет pg_cron. Полный пересчёт = снапшот + записи после него. На текущих объёмах не нужно.

### Деньги
- В БД суммы хранятся как `numeric(78,0)` **в минимальных единицах** токена. 78 цифр вмещают uint256,
  поэтому модель подходит для любого ERC-20, включая 18-decimal.
- В коде используется `bigint`; `number` для денег запрещён.
- В API суммы передаются **десятичными строками** в единицах токена (`"12.5"`). Так же их ожидает и
  возвращает Circle. Парсинг строгий: лишние знаки после запятой — ошибка, а не округление.

---

## 6. Модель данных

Все таблицы лежат в схеме `app`. PostgREST её не публикует, а RLS запрещает доступ ролям
`anon`/`authenticated` (см. §14).

| Таблица | Назначение | Ключевые ограничения |
|---|---|---|
| `tokens` | Allowlist токенов: symbol, Circle `token_id`, адрес контракта, decimals | PK `symbol`, `UNIQUE(circle_token_id)` |
| `users` | Пользователи | |
| `wallets` | Кошельки Circle: `kind ∈ {DEPOSIT, TREASURY}`, статус создания, адрес | `UNIQUE(user_id)` для DEPOSIT; один TREASURY; `UNIQUE(circle_wallet_id)`, `UNIQUE(address)` |
| `ledger_accounts` | Счета и кешированные балансы | `UNIQUE NULLS NOT DISTINCT (type, token, user_id, wallet_id)`, `CHECK balance ≥ 0` |
| `ledger_transactions` | Проводки | `UNIQUE(kind, reference_id)` |
| `ledger_entries` | Записи проводок (append-only) | `CHECK amount > 0`, deferred balance check |
| `deposits` | Входящие на deposit wallets | `UNIQUE(circle_transaction_id)` |
| `withdrawals` | Выводы | `UNIQUE(user_id, idempotency_key)`, `UNIQUE(circle_transaction_id)` |
| `sweeps` | Перемещения deposit → treasury | Один активный sweep на (wallet, token) — partial unique index |
| `treasury_inbounds` | Входящие на treasury и их классификация | `UNIQUE(circle_transaction_id)` |
| `webhook_events` | Inbox вебхуков (сырой payload) | PK `notification_id` |
| `jobs` | Очередь задач | partial `UNIQUE(dedupe_key)` для активных задач |
| `sync_cursors` | Курсоры reconciliation | PK `name` |
| `balance_checks` | Результаты сверки custody с on-chain | PK `(wallet_id, token)` |

---

## 7. Жизненные циклы и статусы

### Состояния Circle → наши статусы
Circle: `INITIATED, CLEARED, QUEUED, SENT, STUCK, CONFIRMED, COMPLETE, FAILED, DENIED, CANCELLED`.
Терминальные: `COMPLETE, FAILED, DENIED, CANCELLED`. Сырое состояние храним в `circle_state`.
Переходы **монотонны** по рангу:

| Ранг | Состояния Circle | Комментарий |
|---|---|---|
| 10 | `INITIATED` | |
| 20 | `CLEARED`, `QUEUED` | Источники Circle расходятся в их порядке, поэтому это один уровень |
| 30 | `SENT`, `STUCK` | `STUCK` не терминальный: его можно ускорить (accelerate) |
| 40 | `CONFIRMED` | Может прийти после `COMPLETE` или не прийти вовсе |
| 50 | `COMPLETE`, `FAILED`, `DENIED`, `CANCELLED` | Терминальные: из них переходов нет |

Обновление применяется, только если ранг нового состояния больше текущего. Внутри одного уровня
допускается боковое обновление (`QUEUED`↔`CLEARED`, `SENT`↔`STUCK`), но без эффектов в леджере.
Опоздавший или повторный вебхук ничего не ломает. Эффекты в леджере срабатывают **только на переходе**
в терминальное состояние, под row lock.

### Вывод (`withdrawals.status`)
```
PENDING ──(ликвидность treasury зарезервирована)──▶ SUBMITTING ──(Circle принял, есть id)──▶ SUBMITTED
   │                                                    │                                     │
   │ awaiting_liquidity = true, пока не хватает         │ явный отказ Circle (4xx)           ├─ COMPLETE ──▶ COMPLETED (SETTLE)
   │                                                    ▼                                     └─ FAILED/DENIED/CANCELLED ──▶ FAILED (RELEASE)
   └──────────────────────────────────────────────▶ FAILED (RELEASE)
```
- `PENDING`: средства пользователя уже в hold, вывод ждёт worker'а или ликвидности.
- `SUBMITTING`: ликвидность treasury учтена как «в пути», запрос в Circle отправляется. Если ответ
  потерялся, исход неизвестен: повтор идёт с тем же `idempotencyKey`.
- `SUBMITTED`: у вывода есть `circle_transaction_id`, транзакция в блокчейне.
- `COMPLETED` / `FAILED`: финальные статусы.

### Депозит (`deposits.status`)
`PENDING` (Circle `CONFIRMED`) → `COMPLETED` (`DEPOSIT_CREDIT`) | `FAILED` (зачисления не было).

### Sweep (`sweeps.status`)
`PENDING` → `SUBMITTED` → `COMPLETED` (`SWEEP_SETTLE`) | `FAILED`. После `FAILED` планируется повтор.

### Кошелёк (`wallets.status`)
`PENDING` → `ACTIVE`. Пока кошелёк создаётся, UI показывает «адрес создаётся…».

---

## 8. Ключевые потоки

### 8.1 Создание пользователя
1. `POST /users` в одной транзакции создаёт `users`, `wallets(kind=DEPOSIT, status=PENDING,
   circle_idempotency_key=uuid)` и задачу `wallet.create`, затем отвечает `201`.
2. worker вызывает `POST /v1/w3s/developer/wallets` (`accountType: SCA`, `refId: userId`) с
   сохранённым idempotency key. При ретрае Circle вернёт тот же кошелёк.
3. Кошелёк получает статус `ACTIVE` и адрес; по NOTIFY уходит SSE-событие, и UI показывает адрес.

### 8.2 Депозит
1. Circle присылает `transactions.inbound` (`CONFIRMED`, затем `COMPLETE`).
2. api проверяет подпись, кладёт событие в inbox, ставит задачу `webhook.process` и отвечает `200`.
3. worker находит кошелёк по `walletId` и проверяет токен по allowlist (`tokenId`). Затем upsert
   `deposits` по `circle_transaction_id` и монотонный переход статуса.
4. На переходе в `COMPLETE` в одной транзакции: `DEPOSIT_CREDIT` и задача `sweep.schedule`
   (dedupe `sweep:<wallet>:<token>`).

### 8.3 Sweep
1. `sweep.schedule`: если активный sweep уже есть, ничего не делаем. Иначе сумма = custody-баланс
   кошелька по токену (только `COMPLETE`-депозиты, только allowlist). Если сумма не меньше порога,
   создаём `sweeps(PENDING)`.
2. Transfer deposit wallet → treasury с `idempotencyKey = sweep.id` и `refId = sweep:<id>`
   переводит sweep в `SUBMITTED`.
3. Outbound `COMPLETE` даёт `SWEEP_SETTLE`. Если на кошельке что-то осталось или пришло за это время,
   ставится новый `sweep.schedule`.
4. Входящее на treasury классифицируется как `SWEEP` по `txHash` (см. §4), без проводок.

### 8.4 Вывод
1. `POST /users/:id/withdrawals` с заголовком `Idempotency-Key` и телом `{token, amount, destinationAddress}`.
   Проверки: адрес (формат и EIP-55 checksum), denylist, сумма больше нуля, не больше decimals токена.
2. Одна транзакция:
   - блокировка счёта `USER_AVAILABLE` (`FOR UPDATE`);
   - проверка достаточности средств;
   - `withdrawals(PENDING)`;
   - `WITHDRAWAL_HOLD`;
   - задача `withdrawal.submit`.

   Затем ответ `202`. Повтор с тем же ключом и тем же телом возвращает тот же вывод; с другим
   телом — `409`.
3. worker, задача `withdrawal.submit`:
   - блокирует `CUSTODY(treasury)` и считает ликвидность = custody − Σ выводов в `SUBMITTING|SUBMITTED`;
   - если ликвидности мало: `awaiting_liquidity = true`, задача откладывается без расхода попыток;
   - иначе ставит `SUBMITTING` и делает commit;
   - если это повторная попытка (вывод уже `SUBMITTING`), сначала ищет транзакцию в Circle по `refId`;
   - затем вызывает `POST /v1/w3s/developer/transactions/transfer` с `idempotencyKey = withdrawal.id`,
     `refId = withdrawal:<id>`, `feeLevel = MEDIUM`.
4. Ответ Circle:
   - есть `id` → ответ применяется через ту же state machine, что и вебхуки. На повтор Circle может
     вернуть уже терминальное состояние, и оно сразу проводит `SETTLE`/`RELEASE`;
   - явный отказ (4xx) на **первую** отправку → `FAILED` + `WITHDRAWAL_RELEASE`;
   - 4xx на **повторную** отправку резерв **не** освобождает: первый запрос мог создать перевод
     (например, 409 «ещё обрабатывается»). Задача ретраится, а если не сойдётся — уходит в `DEAD`
     на ручной разбор;
   - сеть, 5xx, 408/409/425, 429 или retryable-код → retry с backoff и тем же ключом.
5. Вебхуки `transactions.outbound` и reconciler доводят вывод до `COMPLETED` (`SETTLE`) или
   `FAILED` (`RELEASE`).

### 8.5 House float
Оператор пополняет treasury (адрес показан на `/ops`) с фаусета. Это inbound на treasury, он
классифицируется как `HOUSE_FUNDING`: дебет `custody:treasury`, кредит `house`.

---

## 9. Вебхуки

Подробнее в [ADR-0006](./adr/0006-webhook-inbox-and-verification.md).

- `HEAD /webhooks/circle` отвечает `200`: так Circle валидирует URL при создании подписки.
- `POST /webhooks/circle`: только на этом роуте стоит `express.raw()`, потому что подпись считается
  от **сырых байтов** тела.
  1. Проверка подписи: ECDSA P-256 / SHA-256, заголовки `X-Circle-Signature` (base64 DER) и `X-Circle-Key-Id`.
     Публичный ключ берётся из `GET {CIRCLE_BASE_URL}/v2/notifications/publicKey/{keyId}` и
     кешируется по keyId. Неверная подпись → `401`. Ключ не удалось получить → `503`, чтобы
     Circle повторил отправку и событие не потерялось.
  2. Валидация конверта (zod): `{subscriptionId, notificationId, notificationType, notification, timestamp, version}`.
  3. `webhooks.test` → `200` без побочных эффектов, до dedupe: у тестовых событий бывают нулевые id.
  4. В одной транзакции: `INSERT INTO webhook_events … ON CONFLICT (notification_id) DO NOTHING`
     и задача `webhook.process`. Ответ `200` за миллисекунды; таймаут Circle около 5 секунд.
- Доставка у Circle **at-least-once без гарантии порядка**. Дубли отсекаются по `notificationId`,
  порядок не важен благодаря монотонной state machine (§7).
- Маршрутизация в worker'е идёт по `walletId` и направлению:
  - inbound на deposit wallet → депозит;
  - inbound на treasury → классификация (§4);
  - outbound с treasury → вывод (по `circle_transaction_id`, затем по `refId`);
  - outbound с deposit wallet → sweep;
  - неизвестный кошелёк или токен → событие помечается `IGNORED` с причиной.
- Вывод может получить вебхук **раньше**, чем сохранён ответ на create transfer. Тогда поиск идёт
  по `refId`; если и он не помог, задача повторяется с backoff.

---

## 10. Фоновая обработка: очередь задач в Postgres

Подробнее в [ADR-0005](./adr/0005-postgres-job-queue-separate-worker.md).

- **Таблица `jobs`:** `kind`, `payload`, `status ∈ {PENDING, RUNNING, DONE, DEAD}`, `attempts`,
  `max_attempts`, `run_at`, `locked_by`, `locked_until`, `dedupe_key`, `last_error`.
- **Transactional outbox:** задача вставляется **в той же транзакции**, что и бизнес-изменение.
  Вывод без задачи на отправку (и наоборот) невозможен.
- **Захват:** `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT n)`, lease 120 с по часам
  БД. Берутся `PENDING` с наступившим `run_at`, а также `RUNNING` с истёкшим lease (воркер умер).
- **Завершение с fencing:** `UPDATE … WHERE id = $1 AND locked_by = $2 AND attempts = $3`. Результат
  «опоздавшего» запуска, чей lease уже перехватили (даже тот же воркер), не применится.
- **Время** (`run_at`, lease) считается только по часам БД: расхождение часов приложения его не ломает.
- **Ретраи:** exponential backoff с jitter, до 5 минут. После `max_attempts` задача получает статус
  `DEAD`, видна на `/ops`, payload сохраняется для повторного запуска.
- **Исходы обработчика:** `done`, `retry(delay)`, `reschedule(delay)` (ожидание ликвидности, без
  расхода попыток), `fail` (сразу `DEAD`).
- **Dedupe:** partial unique index на `dedupe_key` среди активных задач. Например, одновременно
  существует не больше одной `reconcile.pending` и одной `sweep:<wallet>:<token>`.
- **Пробуждение:** триггер на `INSERT` в `jobs` делает `NOTIFY app_jobs`, worker держит `LISTEN`.
  Как подстраховка — опрос раз в секунду. После sweep, house funding или освобождения резерва будятся
  только выводы, ждущие ликвидности. Выводы с неизвестным исходом остаются на своём backoff, иначе во
  время сбоя Circle получился бы шквал повторов.
- **Без параллельных дублей:** reconciliation досоздаёт задачу через `ensureJob`. Новая задача не
  появляется, пока такая же ждёт или выполняется. Недавно умершая (`DEAD`) воскрешается не раньше
  чем через 10 минут, чтобы постоянная ошибка не превратилась в бесконечный цикл. Периодическая
  задача не ставится, пока предыдущая того же вида ещё работает.
- **Graceful shutdown** по `SIGTERM`/`SIGINT`: перестать брать задачи и дождаться текущих.
  Незавершённые задачи подхватятся после истечения lease.

### Типы задач

| `kind` | Кто ставит | Что делает |
|---|---|---|
| `wallet.create` | `POST /users` | Создаёт SCA-кошелёк в Circle |
| `webhook.process` | Приём вебхука | Применяет событие Circle |
| `withdrawal.submit` | `POST …/withdrawals` | Проверяет ликвидность и отправляет transfer |
| `sweep.schedule` | Депозит `COMPLETE`, завершение sweep | Решает, нужен ли sweep, и отправляет его |
| `treasury-inbound.classify` | Inbound на treasury | Классифицирует поступление (§4) |
| `reconcile.pending` | pg_cron, каждые 30 с | Опрашивает Circle по незавершённым операциям |
| `reconcile.inbound` | pg_cron, каждую минуту | Ищет пропущенные входящие транзакции |
| `reconcile.balances` | pg_cron, каждые 5 мин | Сверяет custody с on-chain балансами |

**pg_cron — планировщик, а не исполнитель.** Он только ставит задачу; выполняют её воркеры.
Плюсы: один планировщик на любое число воркеров без leader election, расписание переживает
рестарты приложения, история запусков видна в `cron.job_run_details`. Исполнителем pg_cron быть
не может: вызовы Circle требуют API key и RSA-OAEP-шифрования entity secret на каждый запрос.

---

## 11. Reconciliation

Вебхуки могут не дойти. У quick tunnel нет гарантий доступности, а на часть состояний (например,
`DENIED`) Circle outbound-вебхук, судя по документации, не шлёт. Поэтому корректность не зависит
от вебхуков.

- **`reconcile.pending`:**
  - у каждой незавершённой операции (`PENDING`/`SUBMITTING`-выводы, `PENDING`-sweep, кошельки)
    гарантированно есть задача-«двигатель»;
  - выводы `SUBMITTED`, sweeps `SUBMITTED` и депозиты `PENDING` опрашиваются через
    `GET /v1/w3s/transactions/{id}?txType=…`;
  - очередь опроса упорядочена по `last_reconciled_at`: каждая проверка отправляет строку в конец,
    поэтому «застрявшие» операции не вытесняют остальные;
  - результат применяется **тем же кодом**, что и вебхук.
- **`reconcile.inbound`:** `GET /v1/w3s/transactions?txType=INBOUND&walletIds=…&from=<cursor − overlap>`
  с пагинацией по `pageAfter`. Курсор хранится в `sync_cursors`. Каждая найденная транзакция
  применяется идемпотентно.
- **`reconcile.balances`:** `GET /v1/w3s/wallets/{id}/balances` сравнивается с `CUSTODY`, результат
  пишется в `balance_checks` и показывается на `/ops`. Расхождение «on-chain меньше леджера» —
  тревога. Обратное временно нормально: `CONFIRMED`-депозиты, неклассифицированные поступления.

---

## 12. Идемпотентность (сквозная)

| Уровень | Механизм |
|---|---|
| Клиент → API | Заголовок `Idempotency-Key` + хэш тела; `UNIQUE(user_id, idempotency_key)`. Тот же ключ с тем же телом → тот же ответ, с другим телом → `409` |
| API/worker → Circle | `idempotencyKey` детерминирован: это id нашей сущности (`withdrawal.id`, `sweep.id`, `wallets.circle_idempotency_key`). `entitySecretCiphertext` новый на каждый запрос (Circle запрещает повтор). `refId` позволяет найти транзакцию, если ответ потерялся |
| Circle → API (вебхуки) | PK `notification_id` в inbox |
| Применение событий | Монотонная state machine + row lock + `UNIQUE(kind, reference_id)` в леджере |
| Очередь | `dedupe_key` + fencing по `locked_by` |

---

## 13. Real-time: SSE поверх LISTEN/NOTIFY

Подробнее в [ADR-0008](./adr/0008-sse-over-listen-notify.md).

- Триггеры на `wallets`, `deposits`, `withdrawals`, `ledger_accounts`, `sweeps` и `treasury_inbounds`
  делают `pg_notify('app_events', '{"userId": …}')` **в той же транзакции**. По документации Postgres
  уведомление доставляется только после commit. Одинаковые уведомления внутри транзакции
  схлопываются, порядок между транзакциями соответствует порядку commit'ов.
- Каждый инстанс api держит одно `LISTEN`-соединение и раздаёт события подключённым SSE-клиентам.
  Эндпоинты: `GET /users/:id/events` (события одного пользователя) и `GET /events` (все события,
  для списка пользователей и `/ops`).
- **Событие — сигнал invalidate, а не данные.** Клиент перечитывает данные по REST (TanStack Query
  `invalidateQueries`), а при каждом (пере)подключении делает полный refetch. Пропущенное событие
  безвредно, журнал для `Last-Event-ID` не нужен.
- Мелочи: heartbeat каждые 15 с; `Cache-Control: no-cache`, `X-Accel-Buffering: no`; без compression.
  При обрыве `LISTEN`-соединения api переподключается и шлёт клиентам `resync`.

---

## 14. Интеграция с Circle и безопасность

### Клиент Circle
Свой тонкий клиент на `fetch` за интерфейсом `CircleGateway`. Подробнее в
[ADR-0007](./adr/0007-own-circle-http-client.md).
- Base URL берётся строго из `CIRCLE_BASE_URL`, завершающий `/` обрезается. Пагинация строится от
  base URL, а не от абсолютных ссылок из `Link`.
- `entitySecretCiphertext` = base64(RSA-OAEP-SHA256(entity secret)) на публичном ключе
  `GET /v1/w3s/config/entity/publicKey` (ключ кешируется). Новый на каждый мутирующий запрос.
- Таймауты через `AbortSignal`; ответы валидируются zod-схемами.
- Классификация ошибок:
  - **unknown outcome** (сеть, таймаут, 5xx) → повтор с тем же ключом;
  - **retryable** (`429`, `155505`, `155264`, `155210`, `155202`, `156004`) → повтор;
  - **config** (`401`/`403`) → повтор и алерт; вывод пользователя не проваливается из-за нашей ошибки конфигурации;
  - **definitive** (остальные 4xx) → вывод `FAILED`.
- **Минимальный контракт:** основной поток опирается на четыре эндпоинта (create wallet, transfer,
  get transaction, notification public key). Поиск по `refId`, list transactions и balances
  используются в reconciliation и отключаются мягко, если их нет (например, в моке).

### Безопасность
- Секреты только в env. В логах они маскируются (`pino` redact); recovery file лежит вне репозитория.
- Подпись каждого вебхука проверяется, публичный ключ берётся через тот же `CIRCLE_BASE_URL`.
- Supabase: таблицы в схеме `app`, которую PostgREST не публикует; RLS включён;
  `anon`/`authenticated` не имеют прав. Бэкенд ходит в БД напрямую, ключи Supabase ему не нужны.
- Аутентификации нет по ТЗ. В проде нужны authN/authZ на все `/users/:id/*`, отдельная защита
  `/ops`, rate limiting и AML-скоринг адресов вывода.

---

## 15. API (кратко)

Полное описание в [README](../README.md#api).

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/health`, `/ready` | Liveness / readiness (проверка БД) |
| `GET` | `/tokens` | Поддерживаемые токены |
| `POST` | `/users` | Создать пользователя (кошелёк создаётся асинхронно) |
| `GET` | `/users` | Список пользователей |
| `GET` | `/users/:id` | Пользователь, deposit-адрес, балансы по токенам |
| `GET` | `/users/:id/operations` | История депозитов и выводов (cursor pagination) |
| `POST` | `/users/:id/withdrawals` | Создать вывод (`Idempotency-Key`) |
| `GET` | `/users/:id/events` | SSE-стрим событий пользователя |
| `GET` | `/events` | SSE-стрим всех событий |
| `HEAD`/`POST` | `/webhooks/circle` | Вебхуки Circle |
| `GET` | `/ops/overview` | Treasury, house, ликвидность, тождество леджера, очередь, сверка |

---

## 16. Матрица отказов

| Сбой | Что произойдёт | Итог |
|---|---|---|
| api упал после commit вывода, ответ не дошёл | Клиент повторяет с тем же `Idempotency-Key` и получает тот же вывод | Дублей нет |
| api упал при приёме вебхука до записи в inbox | Circle не получил 2xx и повторит | Событие не потеряно |
| Вебхук пришёл дважды | `ON CONFLICT DO NOTHING` → `200` | Дубль отброшен |
| Вебхуки пришли не по порядку | Монотонная state machine | Корректный финальный статус |
| worker упал после отправки transfer, но до сохранения ответа | Lease истекает; повтор: поиск по `refId`, затем тот же `idempotencyKey` → Circle вернёт существующую транзакцию | Двойной отправки нет |
| worker упал посреди обработки события | Транзакция откатилась, задача повторится | Атомарно |
| Circle: 5xx / timeout / 429 | Retry с backoff и тем же ключом, hold сохраняется | Деньги в резерве |
| Circle: явный отказ на первую отправку | `FAILED` + `RELEASE` в одной транзакции | Деньги вернулись |
| Circle: 4xx на повторную отправку после неизвестного исхода | Резерв держится, повтор и затем ручной разбор; если перевод на самом деле прошёл, его найдут вебхук или сверка по `refId` | Двойной траты нет |
| Ответ на повтор пришёл сразу с `COMPLETE` | Применяется через state machine → `SETTLE` | Вывод не зависает |
| Вебхук не пришёл вовсе | `reconcile.pending` / `reconcile.inbound` | Догоняем |
| Двойной клик / гонка выводов | `Idempotency-Key`, `FOR UPDATE`, `CHECK ≥ 0` | Double-spend невозможен |
| Воркеры лежали час | Dedupe: максимум одна ожидающая периодическая задача каждого типа | Лавины нет |
| Postgres недоступен | api → `503`; вебхук → `5xx` (Circle повторит); worker → backoff | Ничего не применено частично |
| Treasury без ликвидности | Вывод ждёт `awaiting_liquidity`, sweep или house float её дают | Вывод уйдёт позже |
| Задача падает постоянно (баг) | После N попыток → `DEAD`, видно на `/ops`, payload сохранён | Можно переиграть после фикса |

---

## 17. Известные ограничения и future work
- **Один hot wallet** — узкое место по throughput: у SCA ограничена очередь на кошелёк (`155264`).
  В проде используют пул hot wallets и отдельные кошельки под sweep.
- **Внутренние переводы** между пользователями идут on-chain. Можно делать off-chain проводкой.
- **STUCK** только наблюдается. В проде нужен авто-accelerate после таймаута.
- **Снапшоты балансов** (pg_cron) и партиционирование `ledger_entries` нужны при росте объёмов.
- **NOTIFY** на большом масштабе стоит заменить на Redis/NATS pub/sub.
- **Аутентификация**, комиссии, лимиты, AML.
- **Учёт газа:** сейчас его спонсирует Gas Station. В проде нужен счёт расходов по нативному токену.
- **Порог sweep** сейчас один для всех токенов (`SWEEP_MIN_AMOUNT`); в проде он свой у каждого токена.

---

## 18. Тестирование
- **Unit:** парсинг и форматирование денег; state machine рангов; проверка подписи вебхука
  (генерируем P-256 ключ); Circle-клиент с подменённым `fetch` (свежий ciphertext на каждый запрос,
  классификация ошибок, пагинация от base URL).
- **Integration** на реальном Postgres (testcontainers):
  - инварианты леджера: баланс проводки, append-only, `CHECK ≥ 0`;
  - гонка параллельных выводов (double-spend);
  - идемпотентность и порядок вебхуков;
  - классификация входящих на treasury;
  - очередь: lease, fencing, dedupe.

  Circle подменяется `FakeCircleGateway`.
- **E2E:** ручной прогон на реальном Circle (BASE-SEPOLIA) по сценарию из README.
