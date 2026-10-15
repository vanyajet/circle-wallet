# Circle Wallet

Fullstack-криптокошелёк на [Circle Developer-Controlled Wallets](https://developers.circle.com/wallets/dev-controlled/create-your-first-wallet) в тестовой сети `BASE-SEPOLIA`.
Пользователь пополняет кошелёк тестовыми USDC/EURC, выводит их на любой внешний адрес и видит баланс и историю операций со статусами в реальном времени.

- **Бэкенд:** Express + TypeScript. Два процесса: `api` и `worker`.
- **База:** Supabase (Postgres 17), миграции в `supabase/migrations`.
- **Фронтенд:** Next.js 16 + Tailwind CSS v4 + TanStack Query.

Подробности:
- [`docs/design-doc.md`](docs/design-doc.md) — дизайн, потоки, матрица отказов;
- [`docs/adr/`](docs/adr) — решения с альтернативами, плюсами и минусами;
- [`docs/research/circle-api-notes.md`](docs/research/circle-api-notes.md) — исследование Circle API.
- [`docs/interview-notes.md`](docs/interview-notes.md) — ключевые вопросы и ответы, результаты живого прогона.

---

## Содержание
1. [Архитектура коротко](#архитектура-коротко)
2. [Запуск локально](#запуск-локально)
3. [Переменные окружения](#переменные-окружения)
4. [Проверка сценариев end-to-end](#проверка-сценариев-end-to-end)
5. [API](#api)
6. [Ключевые решения и почему так](#ключевые-решения-и-почему-так)
7. [Тесты](#тесты)
8. [Структура репозитория](#структура-репозитория)
9. [Известные ограничения](#известные-ограничения)

---

## Архитектура коротко

```
 Next.js (браузер) ──REST/SSE──▶ api (Express) ◀──── webhooks ──── Circle (BASE-SEPOLIA)
                                   │   ▲ LISTEN                        ▲
                         SQL + NOTIFY  │                               │ create wallet / transfer / get tx
                                   ▼   │                               │
                       Postgres (Supabase): данные, леджер, очередь jobs, inbox вебхуков
                       pg_cron → периодические задачи сверки            │
                                   ▲                                    │
                                   └──── worker (SKIP LOCKED) ──────────┘
```

- **Omnibus-модель хранения**, как в реальных кастодиальных системах:
  - у каждого пользователя свой deposit-адрес (SCA-кошелёк Circle);
  - после финализации депозита средства сметаются (sweep) на общий **treasury** (hot wallet);
  - все выводы идут из treasury, а принадлежность средств определяет **double-entry ledger**.
- **Газ** оплачивает Circle Gas Station: все кошельки SCA, ETH на них не нужен.
- **api** работает быстро и надёжно: принимает REST-запросы, проверяет подпись вебхука и пишет его в inbox, держит SSE-соединения. В Circle с мутациями не ходит.
- **worker** выполняет задачи из очереди в Postgres: создание кошельков, отправку выводов, sweep, обработку вебхуков, сверку.
  - Задачи ставятся **в той же транзакции**, что и бизнес-изменение (transactional outbox).
  - Захват идёт через `FOR UPDATE SKIP LOCKED` с lease.
- **Сверка (reconciliation)** по расписанию pg_cron: корректность не зависит от доставки вебхуков.
- **Real-time:** триггеры БД делают `NOTIFY`, api раздаёт SSE, клиент перечитывает данные по REST.

---

## Запуск локально

### 0. Что нужно установить
| Инструмент | Зачем | Установка (macOS) |
|---|---|---|
| Node.js ≥ 22 (проверено на 24) | рантайм | `brew install node` / nvm (`.nvmrc`) |
| pnpm 10 | монорепо | `corepack enable` или `npm i -g pnpm` |
| Supabase CLI | применение миграций | `brew install supabase/tap/supabase` |
| cloudflared | публичный HTTPS для вебхуков | `brew install cloudflared` |
| Docker | только для интеграционных тестов | Docker Desktop |

```bash
pnpm install
cp .env.example .env
```

### 1. Circle
1. Зарегистрируйтесь в [Circle Console](https://console.circle.com). Аккаунт бесплатный, по умолчанию testnet.
2. **API key:** Console → **Keys → Create a key → API key → Standard Key**. Ключ формата `TEST_API_KEY:…` положите в `.env` → `CIRCLE_API_KEY`.
3. **Entity secret:** сгенерируйте `openssl rand -hex 32` и положите результат в `.env` → `CIRCLE_ENTITY_SECRET`. Затем зарегистрируйте его:
   ```bash
   pnpm circle:register-secret
   ```
   Circle выдаст **recovery file**, он сохранится в `secrets/` (папка в `.gitignore`). Перенесите его в надёжное место: Circle выдаёт его один раз.
   Можно и вручную, по [инструкции Circle](https://developers.circle.com/wallets/dev-controlled/register-entity-secret).
4. **Wallet set и treasury:**
   ```bash
   pnpm circle:bootstrap
   ```
   Скрипт создаст wallet set и SCA-кошелёк treasury, запишет `CIRCLE_WALLET_SET_ID` и `CIRCLE_TREASURY_WALLET_ID` в `.env` и выведет адрес treasury.
5. **Gas Station:** для тестнетов Circle создаёт дефолтную политику автоматически. Убедиться можно в Console → Gas Station. Если политики нет, исходящие переводы упадут с `PAYMASTER_POLICY_*`.

### 2. Supabase
1. Создайте проект в [Supabase Dashboard](https://supabase.com/dashboard). Free tier достаточно. Пароль БД лучше сделать из букв и цифр, тогда его не нужно экранировать в URL.
2. Кнопка **Connect** → **Session pooler** → скопируйте URI в `.env` → `DATABASE_URL`.
   > Нужен именно **Session pooler** (порт 5432):
   > - direct connection на free tier доступен только по IPv6;
   > - transaction mode (6543) не поддерживает `LISTEN/NOTIFY`, на котором построены SSE и пробуждение worker'а.
3. Примените миграции:
   ```bash
   pnpm db:push
   ```
   Миграции создают схему `app` (PostgREST её не публикует, RLS включён) и расписания pg_cron (на Supabase он включён по умолчанию). Больше ничего настраивать не нужно.

### 3. Запуск
```bash
pnpm dev       # api :4000 + worker + web :3000
pnpm tunnel    # во втором терминале: cloudflared quick tunnel + подписка Circle на вебхуки
```
`pnpm tunnel` делает три вещи:
1. поднимает бесплатный `https://<random>.trycloudflare.com`;
2. ждёт, пока адрес начнёт отвечать (DNS нового туннеля иногда появляется через 1–2 минуты);
3. пересоздаёт подписку Circle на `…/webhooks/circle`. Circle проверяет URL HEAD-запросом, поэтому api должен быть запущен.

При каждом перезапуске quick tunnel получает новый адрес, и подписка пересоздаётся автоматически.

Без туннеля приложение тоже работает: reconciliation по pg_cron догонит все депозиты и статусы, только медленнее (до минуты).

Откройте http://localhost:3000.

---

## Переменные окружения

Один `.env` в корне используют все процессы. Шаблон с комментариями, где брать значения, — [`.env.example`](.env.example).

| Переменная | Обязательна | Описание |
|---|---|---|
| `CIRCLE_BASE_URL` | да | Адрес Circle API, по умолчанию `https://api.circle.com`. Все запросы, включая пагинацию и публичный ключ вебхуков, строятся строго от него, поэтому подходит и мок |
| `CIRCLE_API_KEY` | да | `TEST_API_KEY:<id>:<secret>` |
| `CIRCLE_ENTITY_SECRET` | да | 64 hex-символа; регистрируется `pnpm circle:register-secret` |
| `CIRCLE_BLOCKCHAIN` | нет | `BASE-SEPOLIA` |
| `CIRCLE_WALLET_SET_ID` | да* | Заполняет `pnpm circle:bootstrap` |
| `CIRCLE_TREASURY_WALLET_ID` | да* | Заполняет `pnpm circle:bootstrap` |
| `CIRCLE_REQUEST_TIMEOUT_MS` | нет | Таймаут запроса к Circle, по умолчанию 15000 |
| `PUBLIC_API_URL` | нет | Публичный адрес api; заполняет `pnpm tunnel` |
| `DATABASE_URL` | да | Supabase **Session pooler** URI |
| `DB_POOL_MAX` | нет | Пул соединений на процесс, по умолчанию 3 (пул pooler'а на free tier маленький) |
| `DATABASE_SSL` | нет | `auto` (TLS везде, кроме localhost) / `require` / `disable` |
| `API_PORT` | нет | 4000 |
| `CORS_ORIGIN` | нет | `http://localhost:3000` (можно перечислить через запятую) |
| `WORKER_CONCURRENCY` | нет | Параллелизм worker'а, по умолчанию 4 |
| `SWEEP_MIN_AMOUNT` | нет | Порог sweep в единицах токена, по умолчанию `1`: мелочь не сметаем |
| `LOG_LEVEL` | нет | `info` |
| `NEXT_PUBLIC_API_URL` | нет | Адрес api для браузера, по умолчанию `http://localhost:4000` |

\* без них не создаются кошельки и не работают выводы.

Проверить `.env`, не показывая значений: `pnpm env:check`.

---

## Проверка сценариев end-to-end

1. **Пользователь.** На главной создайте пользователя. Через несколько секунд у него появится deposit-адрес: задача `wallet.create` создаёт SCA-кошелёк в Circle. Пользователя можно выбрать из списка.
2. **Пополнение.** Откройте [faucet.circle.com](https://faucet.circle.com), выберите сеть **Base Sepolia** (по умолчанию в форме стоит ARC), введите deposit-адрес пользователя и выберите USDC или EURC.
   - В истории появится «Пополнение — Ожидает финализации» (`CONFIRMED`).
   - После `COMPLETE` статус станет «Зачислен», и вырастет баланс `available`.
   - На странице `/ops` видно, как worker сметает депозит (sweep) на treasury.
3. **House float** (не обязательно, но так выводы не ждут sweep). На `/ops` скопируйте адрес treasury и пополните его с фаусета. Поступление будет классифицировано как `HOUSE_FUNDING`, вырастет счёт `HOUSE` и ликвидность treasury.
4. **Вывод.** На странице пользователя укажите токен, сумму и внешний адрес.
   - Сумма сразу переходит из `available` в «в резерве» (hold).
   - Статусы идут так: «В очереди» → «Отправляется» → «В сети» → «Выполнен»; при ошибке — «Не выполнен», и средства возвращаются в `available`.
   - Если ликвидности treasury не хватает, вывод показывается «В очереди · ждёт ликвидности treasury» и уходит, как только завершится sweep.
5. **Баланс и история** обновляются сами через SSE, без перезагрузки страницы.

Тестовый Base Sepolia-адрес для вывода можно взять любой свой (MetaMask и т.п.). Также можно вывести на deposit-адрес другого пользователя системы: средства пройдут on-chain и зачислятся ему как депозит.

---

## API

Базовый URL: `http://localhost:4000`. Формат — JSON.
- **Суммы** передаются десятичными строками в единицах токена (`"12.5"`); внутри они хранятся как `numeric(78,0)` в минимальных единицах.
- **Даты** — ISO-8601.
- **Типы** запросов и ответов — в [`packages/shared/src/api.ts`](packages/shared/src/api.ts).

| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/health` | Liveness |
| `GET` | `/ready` | Readiness (проверяет БД) |
| `GET` | `/tokens` | Поддерживаемые токены (allowlist): `{ items: [{ symbol, decimals, blockchain, contractAddress }] }` |
| `GET` | `/users` | Список пользователей, новые сверху: `{ items: [{ id, name, createdAt, depositAddress, walletStatus }] }` |
| `POST` | `/users` | Создать пользователя. Тело `{ "name": "Alice" }` → `201` с `walletStatus: "PENDING"`; адрес появится после создания кошелька в Circle |
| `GET` | `/users/:id` | Пользователь, deposit-адрес и балансы: `balances: [{ token, decimals, available, held }]` |
| `GET` | `/users/:id/operations?limit=20&cursor=…` | История депозитов и выводов: `{ items: OperationDto[], nextCursor }` (keyset-пагинация) |
| `POST` | `/users/:id/withdrawals` | Создать вывод (подробности ниже) |
| `GET` | `/users/:id/events` | SSE-стрим событий пользователя |
| `GET` | `/events` | SSE-стрим всех событий (список пользователей, ops) |
| `GET` | `/ops/overview` | Treasury, ликвидность, house, тождество леджера, очередь задач, сверка с on-chain, последние sweep и входящие на treasury |
| `HEAD`, `POST` | `/webhooks/circle` | Вебхуки Circle (подпись проверяется) |

### Создание вывода
```http
POST /users/{id}/withdrawals
Idempotency-Key: 6f1c…-uuid
Content-Type: application/json

{ "token": "USDC", "amount": "1.5", "destinationAddress": "0xAbC…" }
```
- **`202`** — вывод принят, средства в резерве. Тело — `OperationDto` со статусом `PENDING`.
- **Повтор с тем же `Idempotency-Key` и тем же телом** возвращает тот же вывод (`200`). С другим телом — `409 IDEMPOTENCY_KEY_REUSED`.
- **Проверки:** EVM-адрес с EIP-55 checksum; сумма больше нуля и не длиннее decimals токена. Запрещены нулевой адрес, адрес контракта токена, treasury и собственный deposit-адрес.

`OperationDto`:
```json
{
  "id": "uuid", "type": "WITHDRAWAL", "token": "USDC", "amount": "1.5",
  "status": "SUBMITTED", "circleState": "SENT", "txHash": null,
  "counterpartyAddress": "0xabc…", "awaitingLiquidity": false,
  "errorReason": null, "errorDetails": null,
  "createdAt": "…", "updatedAt": "…", "completedAt": null
}
```

### Статусы
| Операция | Статусы |
|---|---|
| Депозит | `PENDING` (виден в сети, ждём финализации) → `COMPLETED` (зачислен) \| `FAILED` |
| Вывод | `PENDING` (средства в резерве, ждём отправки/ликвидности) → `SUBMITTING` (отправляем в Circle) → `SUBMITTED` (в сети) → `COMPLETED` \| `FAILED` (средства возвращены) |

Сырое состояние Circle (`INITIATED … COMPLETE`) приходит в поле `circleState`.

### Ошибки
`{ "error": { "code": "…", "message": "…", "details"?: … } }`

| HTTP | Коды |
|---|---|
| 400 | `VALIDATION_ERROR`, `INVALID_AMOUNT`, `INVALID_ADDRESS`, `TOKEN_NOT_SUPPORTED`, `IDEMPOTENCY_KEY_REQUIRED` |
| 404 | `NOT_FOUND` |
| 409 | `IDEMPOTENCY_KEY_REUSED` |
| 422 | `INSUFFICIENT_FUNDS` (`details.available`), `ADDRESS_NOT_ALLOWED` |
| 503 | `SERVICE_UNAVAILABLE` (БД недоступна) |

### SSE
`GET /users/:id/events` и `GET /events` отдают `text/event-stream` с событиями:
- `ready` — подключились, перечитайте данные;
- `invalidate` (`{"userId": "…" | null}`) — данные устарели;
- `resync` — сервер мог пропустить события, перечитайте всё.

Событие — только сигнал, сами данные клиент берёт по REST. Поэтому потеря события безвредна ([ADR-0008](docs/adr/0008-sse-over-listen-notify.md)). Heartbeat-комментарий приходит каждые 15 с.

### Вебхуки Circle
`POST /webhooks/circle`, типы `transactions.inbound` и `transactions.outbound`.
1. Проверяется подпись ECDSA P-256 по сырому телу (`X-Circle-Signature`, `X-Circle-Key-Id`); ключ берётся через `CIRCLE_BASE_URL`.
2. Событие пишется в inbox (dedupe по `notificationId`), и ставится задача на обработку.
3. Ответ `200` за миллисекунды.

| Ответ | Когда |
|---|---|
| `401` | Неверная подпись |
| `503` | Не удалось получить публичный ключ или БД недоступна. Circle повторит доставку |

---

## Ключевые решения и почему так

Полные обоснования с альтернативами — в [`docs/adr`](docs/adr).

| Решение | Почему |
|---|---|
| **Omnibus: treasury + deposit-адреса + sweep** ([ADR-0001](docs/adr/0001-omnibus-custody-model.md)) | Так работают реальные кастодиальные кошельки и биржи: единая ликвидность, учёт в леджере, готовность к hot/cold. Sweep проводится по своей outbound-транзакции; входящие на treasury классифицируются (sweep / house float), при сомнении — в безопасную сторону |
| **SCA + Gas Station** ([ADR-0002](docs/adr/0002-sca-wallets-gas-station.md)) | EOA (тип по умолчанию у Circle) платит газ в ETH, которого нет в публичном фаусете. SCA на тестнете спонсируется Circle |
| **Double-entry ledger с инвариантами в БД** ([ADR-0003](docs/adr/0003-double-entry-ledger.md)) | Баланс проводки, append-only, exactly-once (`UNIQUE(kind, reference_id)`) и `CHECK balance ≥ 0` гарантирует Postgres, а не только код. Кешированный баланс обновляется триггером в той же транзакции. Суммы — `numeric(78,0)` в минимальных единицах, в коде `bigint`, никакого float |
| **Supabase как managed Postgres, прямое подключение + Kysely** ([ADR-0004](docs/adr/0004-supabase-as-managed-postgres-kysely.md)) | Нужны транзакции из кода, `SKIP LOCKED`, `LISTEN/NOTIFY` и точный `numeric`. У `supabase-js` (PostgREST) этого нет: каждый вызов — отдельная HTTP-транзакция, а `numeric` превращается в JSON number |
| **Своя очередь в Postgres + отдельный worker, pg_cron как планировщик** ([ADR-0005](docs/adr/0005-postgres-job-queue-separate-worker.md)) | Transactional outbox: задача ставится в одной транзакции с проводками. Lease и fencing переживают падения процессов. pg_cron только ставит задачи: вызывать Circle он не может, для этого нужны секреты и RSA-шифрование |
| **Inbox вебхуков** ([ADR-0006](docs/adr/0006-webhook-inbox-and-verification.md)) | Circle доставляет at-least-once без гарантии порядка. Мы мгновенно подтверждаем получение, храним сырой payload, обработку повторяем сами. Dedupe по `notificationId` (не по id транзакции) |
| **Свой HTTP-клиент Circle** ([ADR-0007](docs/adr/0007-own-circle-http-client.md)) | В SDK нет таймаутов и ретраев, он молча подставляет случайный idempotencyKey и не умеет фильтр `refId`. Свой клиент строго следует `CIRCLE_BASE_URL` и валидирует ответы zod |
| **SSE поверх LISTEN/NOTIFY** ([ADR-0008](docs/adr/0008-sse-over-listen-notify.md)) | NOTIFY доставляется только после commit, поэтому клиент не видит откатившихся изменений. Событие служит invalidate-сигналом, а данные идут по REST, так что пропуски безвредны |
| **Сквозная идемпотентность** ([ADR-0009](docs/adr/0009-idempotency-strategy.md)) | `Idempotency-Key` клиента; детерминированный `idempotencyKey` к Circle (id сущности) с новым ciphertext на каждый запрос; `refId` для восстановления потерянного ответа |

Что происходит при сбоях (падения процессов, дубли и потеря вебхуков, таймауты Circle, гонки) — в [матрице отказов](docs/design-doc.md#16-матрица-отказов).

---

## Тесты

```bash
pnpm test     # unit (shared) + интеграционные (backend) — нужен запущенный Docker
```
Интеграционные тесты поднимают **настоящий Postgres 17** (testcontainers), накатывают миграции из `supabase/migrations` и работают с фейковым Circle. Они проверяют:
- double-spend при параллельных выводах;
- идемпотентность `Idempotency-Key` (включая гонку двух одинаковых запросов);
- однократное зачисление при дублях и неправильном порядке вебхуков, игнор токенов вне allowlist, поздний `COMPLETE` после `FAILED`;
- потерянный ответ Circle: второго перевода нет, транзакция находится по `refId`;
- вебхук, пришедший раньше ответа Circle;
- явный отказ Circle (средства возвращаются) и временная ошибка (резерв держится);
- ожидание ликвидности treasury, house float, sweep и классификацию его входящей ноги.

Инварианты леджера дополнительно проверяет тождество Σ CUSTODY = Σ USER_* + Σ HOUSE после каждого сценария.

---

## Структура репозитория

```
apps/
  backend/                 Express API + worker (один пакет, два entrypoint'а)
    src/circle/            свой клиент Circle, схемы ответов, проверка подписи вебхуков
    src/db/                Kysely, типы схемы
    src/domain/            бизнес-логика: леджер, депозиты, выводы, sweep, treasury, reconciliation
    src/jobs/              очередь задач, обработчики, runtime worker'а
    src/http/              Express: REST, вебхуки
    src/realtime/          LISTEN-соединение, SSE hub
    src/entrypoints/       api.ts, worker.ts
    scripts/               register-secret, bootstrap, tunnel, subscribe, env-check
    test/                  интеграционные тесты (testcontainers)
  web/                     Next.js UI
packages/shared/           контракт API (zod + типы), денежные утилиты
supabase/migrations/       схема БД, леджер, очередь, NOTIFY-триггеры, RLS, pg_cron
docs/                      design-doc, ADR, исследование Circle API
```

---

## Известные ограничения
- **Аутентификации нет** (по ТЗ). В проде нужны authN/authZ на `/users/:id/*`, отдельная защита `/ops`, rate limiting и AML-скоринг адресов вывода.
- **Один hot wallet** — узкое место по throughput: у SCA ограничена очередь транзакций на кошелёк. В проде используют пул hot wallets.
- **STUCK-транзакции** только наблюдаются. Авто-accelerate — future work.
- **Внутренние переводы** между пользователями идут on-chain. Можно делать off-chain проводкой.
- **Снапшоты балансов** не нужны на текущих объёмах. Схема к ним готова (pg_cron).
- **TLS к Supabase** без проверки сертификата (`rejectUnauthorized: false`). В проде нужно закрепить CA Supabase.
- **Supabase free tier** засыпает после 7 дней неактивности, вместе с pg_cron.
