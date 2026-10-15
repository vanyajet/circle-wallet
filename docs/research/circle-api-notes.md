# Circle Developer-Controlled Wallets — заметки по исследованию API

> Собрано 2026-10-15 по первоисточникам: документация developers.circle.com, OpenAPI-спеки,
> исходники SDK `@circle-fin/developer-controlled-wallets@10.8.1` и референсные репозитории `circlefin`.
> Ключевые утверждения перепроверены повторно по тем же первоисточникам. Где источники
> противоречат друг другу или молчат, это отмечено явно (раздел «Неизвестные»).

## 1. Аутентификация, base URL, entity secret

- **API key** имеет формат `TEST_API_KEY:<id>:<secret>` и передаётся целиком как `Authorization: Bearer <key>`.
  TEST-ключ работает только с тестнетами. — https://developers.circle.com/api-reference/keys
- **Base URL** один для testnet и mainnet: `https://api.circle.com`, окружение определяет префикс ключа.
  `GET /ping` без авторизации отвечает `{"message":"pong"}`, это удобно для health-check.
  — https://developers.circle.com/openapi/developer-controlled-wallets.yaml
- `CIRCLE_BASE_URL` нужно задавать **без завершающего `/`**: SDK склеивает `basePath + '/v2/...'`
  без нормализации, и со слешем получится `//v2/...`.
- **Entity secret** — 32 случайных байта (hex, 64 символа). Регистрируется один раз на аккаунт,
  удобнее всего через Console. Recovery file скачивается только один раз.
  — https://developers.circle.com/wallets/dev-controlled/register-entity-secret
- **entitySecretCiphertext** = `base64(RSA-OAEP-SHA256(secretBytes))` на публичном ключе из
  `GET /v1/w3s/config/entity/publicKey` (`{data:{publicKey: PEM}}`).
  В Node: `crypto.publicEncrypt({key, padding: RSA_PKCS1_OAEP_PADDING, oaepHash:'sha256'}, buf)`.
  — https://github.com/circlefin/w3s-entity-secret-sample-code
- ⚠️ **Ciphertext одноразовый.** Повторное использование даёт ошибку `156004`. Значит, ретрай
  вывода идёт с **тем же** `idempotencyKey`, но с **новым** ciphertext.
  — https://developers.circle.com/wallets/dev-controlled/entity-secret-management
- Ciphertext требуют только мутирующие developer-эндпоинты: walletSets, wallets, transfer, cancel,
  accelerate, sign/*. GET-запросы, `validateAddress` и `estimateFee` обходятся без него.

## 2. Wallet sets и кошельки

- `POST /v1/w3s/developer/walletSets` с телом `{idempotencyKey, entitySecretCiphertext, name?}`.
  Документация советует **один общий wallet set** и `refId` на каждом кошельке, а не отдельный сет
  на пользователя. Лимиты: 1000 сетов, до 10M кошельков в каждом.
- `POST /v1/w3s/developer/wallets` с телом `{idempotencyKey, entitySecretCiphertext, walletSetId,
  blockchains:['BASE-SEPOLIA'], accountType, count, metadata:[{name, refId}]}`.
  Повтор с тем же ключом возвращает 200 и уже созданные кошельки.
  — https://developers.circle.com/api-reference/wallets/developer-controlled-wallets/create-wallet
- ⚠️ **По умолчанию `accountType` = EOA.** SCA нужно запрашивать явно.
- BASE-SEPOLIA поддерживает и EOA, и SCA. — https://developers.circle.com/wallets/supported-blockchains
- **SCA разворачивается лениво**: контракт деплоится при первой исходящей транзакции, поэтому
  недеплоенный адрес уже может принимать токены. Первый вывод пользователя самый медленный и дорогой.
- Уникальность `refId` у кошельков Circle не гарантирует, следим за ней в своей БД.

## 3. Газ

- На EVM-сетях **EOA платит газ в нативном ETH**. Без ETH транзакция падает с `INSUFFICIENT_NATIVE_TOKEN`
  или отклоняется сразу с `155201`/`155204`. Публичный faucet.circle.com ETH не выдаёт,
  его даёт только Console faucet и только на адреса Circle-кошельков.
- **SCA + Gas Station**: для тестнетов Circle автоматически создаёт дефолтную политику,
  BASE-SEPOLIA в списке поддерживаемых. Пользователю ETH не нужен.
  — https://developers.circle.com/wallets/gas-station , https://developers.circle.com/wallets/gas-station/policy-management
- Для SCA обязателен `feeLevel` (без него ошибка `155232`). Газ не уменьшает USDC-баланс:
  `networkFee` считается в нативном токене и спонсируется.
- Ошибки политики Paymaster бывают синхронными (`155248`–`155256`) и асинхронными
  (`errorReason: PAYMASTER_POLICY_*`).

## 4. Исходящий перевод (вывод)

- `POST /v1/w3s/developer/transactions/transfer`. Схема помечает обязательными только
  `destinationAddress`, `entitySecretCiphertext` и `idempotencyKey`, но на практике нужны ещё:
  - источник: `walletId` (или `walletAddress` + `blockchain`);
  - токен: `tokenId` (или `tokenAddress` + `blockchain`);
  - `amounts: ["1.5"]` — **десятичная строка в целых токенах**, не в base units;
  - `feeLevel: LOW|MEDIUM|HIGH`;
  - `refId` — свободная строка, кладём сюда id нашего вывода.
  Ответ `{data:{id, state}}`: **201** для новой транзакции, **200** для повтора по idempotency key.
  — https://developers.circle.com/api-reference/wallets/developer-controlled-wallets/create-developer-transaction-transfer
- `refId` возвращается в вебхуке (`TransactionNotification.refId`), а `GET /v1/w3s/transactions?refId=`
  ищет по нему (фильтр появился 2026-07-10). Это ключ к reconciliation, если ответ create потерялся.
- `GET /v1/w3s/transactions/{id}` возвращает `{data:{transaction}}`. В пути нет `/developer/`.
- `GET /v1/w3s/transactions` фильтрует по `walletIds, txType, state, refId, txHash, from, to, blockchain,
  includeAll` и т.д. Пагинация: `pageAfter`/`pageBefore` (UUID-курсоры), `pageSize` ≤ 50, плюс заголовок
  `Link` с абсолютными URL на api.circle.com. **Эти URL не используем как есть**: достаём курсор
  и строим запрос от `CIRCLE_BASE_URL`, иначе мок не будет работать.
- `POST /v1/w3s/transactions/validateAddress` с телом `{address, blockchain}` возвращает `{data:{isValid}}`.
- ⚠️ Адрес контракта USDC в denylist: перевод на него падает (`Blacklistable`). Перевод на нулевой
  адрес тоже падает. Оба случая отсекаем локально, до того как резервировать средства.
- Cancel разрешён в `INITIATED|QUEUED|SENT`, accelerate — в `SENT|STUCK`.
- Rate limits: GET 20 rps, POST 5 rps, на превышение **429**.
  — https://developers.circle.com/api-reference/wallets/rate-limits

### Синхронные ошибки create: когда освобождать резерв
- Подлежат ретраю с **тем же** idempotencyKey: сетевые ошибки, 5xx, `429`, `155505` (SCA ещё не
  поставил первую транзакцию в очередь), `155264` (переполнена очередь кошелька), `155210`, `155202`.
- `156020` («Please use a new idempotency key») резерв **не** освобождает. Сначала ищем
  транзакцию по `refId`.
- Явные бизнес-4xx (неверный адрес, нехватка баланса и т.п.) переводят вывод в FAILED и снимают резерв.

## 5. Состояния транзакции

- Enum: `INITIATED, CLEARED, QUEUED, SENT, STUCK, CONFIRMED, COMPLETE, FAILED, DENIED, CANCELLED`.
  Терминальные: `COMPLETE, FAILED, DENIED, CANCELLED`.
  — https://developers.circle.com/api-reference/wallets/transaction-states-and-errors
- ⚠️ Источники Circle расходятся в порядке QUEUED и CLEARED, поэтому для монотонности считаем их
  одним «тиром».
- ⚠️ **STUCK не терминальный.** Его можно ускорить, а пока он висит, следующие транзакции кошелька
  блокируются. Хелпер SDK `getTransaction({waitForState})` ошибочно считает STUCK терминальным,
  поэтому для финализации его не используем.
- CONFIRMED может прийти **после** COMPLETE или не прийти вовсе.
- Inbound-вебхуки документированы только для `CONFIRMED` и `COMPLETE`. **Депозит зачисляем только
  на COMPLETE**: `FAILED_REORG` существует.
- Outbound-вебхуки документированы для `QUEUED, SENT, CONFIRMED, COMPLETE, CANCELLED, FAILED`,
  а **DENIED в этом списке нет**. Финал вывода может вообще не прийти вебхуком, поэтому
  reconciler нужен обязательно.
- У SCA `txHash` появляется только начиная с CONFIRMED.
- REST и вебхук по-разному передают ошибку: в REST `errorReason` есть только у FAILED, а в вебхуке
  он есть всегда (`""`), и `errorDetails: null`. Нужен общий нормализатор.

## 6. Вебхуки

- Подписку создают в Console или через `POST /v2/notifications/subscriptions {endpoint, notificationTypes?}`.
  Типы: `transactions.inbound`, `transactions.outbound`, `transactions.*`.
  — https://developers.circle.com/api-reference/webhook-endpoints
- ⚠️ Endpoint должен быть **публичным HTTPS** и отвечать на **HEAD**: Circle проверяет URL HEAD-запросом
  при создании подписки. Express сам не ответит на HEAD для POST-роута, нужен явный `app.head(...)`.
- Конверт: `{subscriptionId, notificationId, notificationType, notification, timestamp, version: 2}`.
- `notificationType === 'webhooks.test'` отвечаем 2xx без побочных эффектов. Обрабатываем его
  **до** dedupe, потому что у тестовых событий бывают нулевые id.
- **Подпись**: ECDSA_SHA_256 (P-256) от **сырого тела**. Заголовки `X-Circle-Signature`
  (base64 DER) и `X-Circle-Key-Id` (UUID). Ключ берём из `GET /v2/notifications/publicKey/{keyId}`
  (Bearer) → `{data:{publicKey: base64 DER SPKI, algorithm}}` и кешируем по keyId.
  — https://developers.circle.com/api-reference/verify-webhook-signatures
- Для этого роута нужен `express.raw({type: '*/*'})`, иначе байты тела потеряются при парсинге JSON.
- **Доставка at-least-once, без гарантии порядка.** Dedupe делаем по `notificationId`: при ретраях
  он не меняется. На каждое изменение состояния приходит отдельный вебхук со своим `notificationId`.
- ⚠️ В arc-fintech dedupe сделан по `notification.id`, то есть по id транзакции. Из-за этого
  COMPLETE после CONFIRMED отбрасывается как дубликат. Это пример того, как делать **не надо**.
- Payload вебхука урезан по сравнению с REST. Inbound-события могут приходить без `sourceAddress`,
  `txHash` и `refId`. Пользователя определяем по `walletId`.
- Исходящие IP Circle: 54.243.112.156, 100.24.191.35, 54.165.52.248, 54.87.106.46. Подходит как
  defense in depth, но не вместо проверки подписи.
- Retry policy для Wallets не документирована. По архивным данным нужно отвечать за 5 секунд,
  поэтому в обработчике только запись в БД и никаких тяжёлых синхронных вызовов.

## 7. Токены, балансы, faucet

| Токен (BASE-SEPOLIA) | Адрес | Decimals | Circle tokenId |
|---|---|---|---|
| USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | 6 | `bdf128b4-827b-5267-8f9e-243694989b5f` |
| EURC | `0x808456652fdb597867f38412077A9182bf77359F` | 6 | `5b1ba740-7bb7-5695-bd2b-09243ce0f079` |
| ETH (native) | — | 18 | `f2ab11ae-53fa-5373-86e5-8b38447b65fb` |

- tokenId выглядят глобальными (Circle называет их стабильными), но явного подтверждения нет,
  поэтому выносим их в конфиг.
- `GET /v1/w3s/wallets/{id}/balances` возвращает `{data:{tokenBalances:[{amount, token, updateDate}]}}`.
  Токены с нулевым балансом в ответ не попадают.
- Monitored tokens: стоит добавить хотя бы один, и scope переключается на `SELECTED`, после чего
  остальные токены скрыты. Не трогаем; входящие фильтруем по allowlist tokenId в своём коде.
- Флага спама или неизвестного токена нет, поэтому входящие произвольные ERC-20 отсекаем allowlist'ом.
- **faucet.circle.com**: Base Sepolia, USDC и EURC по 20 шт, раз в 1–2 часа на адрес и сеть.
  ETH не выдаёт. По умолчанию в форме выбрана сеть ARC, её нужно переключить на Base Sepolia.
- `POST /v1/faucet/drips` **требует апгрейда до mainnet**, на бесплатном тестовом аккаунте
  рассчитывать на него нельзя.
  — https://developers.circle.com/api-reference/wallets/programmable-wallets/request-testnet-tokens.md

## 8. SDK `@circle-fin/developer-controlled-wallets@10.8.1`

- `initiateDeveloperControlledWalletsClient({apiKey, entitySecret, baseUrl})`: `baseUrl` уходит во все
  внутренние клиенты, включая получение public key. Node ≥ 22.
- Генерирует свежий ciphertext на каждый вызов и кеширует public key.
- ⚠️ Если не передать `idempotencyKey`, SDK подставит `randomUUID()`. Ретрай без своего ключа
  создаст **второй вывод**.
- ⚠️ **Ретраев и таймаутов нет** (используется глобальный axios).
- ⚠️ `createTransaction` требует объект `fee: {type:'level', config:{feeLevel}}`, без него падает с TypeError.
- ⚠️ `listTransactions` не пробрасывает `refId`, а этот фильтр нам нужен для reconciliation.
- Помощника для проверки подписи вебхука нет. Есть `getNotificationSignature(keyId)`, который
  ходит через `baseUrl`.
- Ошибки — типизированные классы с полями `.code` (код Circle, HTTP-статус или строковый errno
  при сетевой ошибке), `.status`, `.message`.

## 9. Референсные реализации Circle

- **arc-commerce** (Next.js + Supabase): проверяет ECDSA по raw body, отвечает 200 на HEAD и
  `webhooks.test`. Статусы применяет через plpgsql RPC `settle_user_transaction()` с `FOR UPDATE`,
  forward-only rank и зачислением ровно один раз. Хороший ориентир.
  — https://github.com/circlefin/arc-commerce
- **arc-fintech**: SCA-кошелёк на пользователя, но ошибка в dedupe (см. выше).
- Официальные quickstart'ы (2026-05) сделаны на ARC-TESTNET с EOA. Их константы не копируем.

## 10. Неизвестные: измерить на e2e-прогоне

- Единица «Daily Limit 50» дефолтной Gas Station на Base Sepolia. Похоже, это 50 ETH/день,
  но это вывод, а не факт.
- Задержка CONFIRMED → COMPLETE на Base Sepolia: Circle её не публикует.
- Лимит mempool на SCA-кошелёк для Base: в таблице Base нет.
- Приходят ли outbound-вебхуки на DENIED, STUCK, INITIATED и CLEARED.
- Шлёт ли Circle `transactions.inbound` для произвольных ERC-20 и для inbound FAILED после реорга.
- Что делает Circle, если повторить transfer с тем же idempotencyKey, но новым ciphertext.
  Ожидаем dedupe, но перед ретраем на всякий случай проверяем `?refId=`.
