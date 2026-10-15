/**
 * Собственный тонкий клиент Circle Developer-Controlled Wallets на fetch (см. ADR-0007).
 *
 * Что он гарантирует:
 *  - все URL строятся строго от CIRCLE_BASE_URL (включая пагинацию и ключ вебхуков) — работает с моком;
 *  - мутирующие запросы получают СВЕЖИЙ entitySecretCiphertext и ЯВНЫЙ idempotencyKey от вызывающего кода;
 *  - у каждого запроса есть таймаут; ответы валидируются zod-схемами;
 *  - ошибки превращаются в CircleApiError с классификацией (см. errors.ts).
 * Ретраев внутри клиента нет намеренно: решение «повторять ли» принимает очередь задач,
 * у которой есть контекст (попытки, backoff, lease).
 */
import { randomUUID, type KeyObject } from 'node:crypto';
import type { z } from 'zod';
import type { Logger } from '../lib/logger';
import { encryptEntitySecret, parseEntityPublicKey } from './entity-secret';
import { CircleApiError } from './errors';
import type {
  CircleGateway,
  CircleTransaction,
  CircleTxType,
  CircleWalletInfo,
  CreateTransferInput,
  CreateWalletInput,
  ListTransactionsFilter,
  NotificationPublicKey,
  TransactionsPage,
  WalletTokenBalance,
} from './gateway';
import {
  CircleErrorBodySchema,
  CreateTransferResponseSchema,
  CreateWalletsResponseSchema,
  EntityPublicKeyResponseSchema,
  GetTransactionResponseSchema,
  GetWalletResponseSchema,
  ListTransactionsResponseSchema,
  NotificationPublicKeyResponseSchema,
  SubscriptionListResponseSchema,
  SubscriptionResponseSchema,
  WalletBalancesResponseSchema,
  WalletSetResponseSchema,
  type CircleRestTransaction,
  type CircleSubscription,
} from './schemas';

export interface CircleClientOptions {
  baseUrl: string;
  apiKey: string;
  entitySecret: string;
  timeoutMs: number;
  logger: Logger;
  /** Подмена fetch для тестов. */
  fetchImpl?: typeof fetch;
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface RequestOptions<S extends z.ZodType> {
  query?: Record<string, string | number | undefined>;
  body?: Record<string, unknown>;
  schema?: S;
}

export class CircleClient implements CircleGateway {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private entityPublicKey: Promise<KeyObject> | null = null;

  constructor(private readonly options: CircleClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  // -------------------------------------------------------------------------
  // Кошельки
  // -------------------------------------------------------------------------

  async createWalletSet(input: { idempotencyKey: string; name: string }): Promise<{ id: string }> {
    const res = await this.request('POST', '/v1/w3s/developer/walletSets', {
      body: {
        idempotencyKey: input.idempotencyKey,
        entitySecretCiphertext: await this.entitySecretCiphertext(),
        name: input.name,
      },
      schema: WalletSetResponseSchema,
    });
    return { id: res.body.data.walletSet.id };
  }

  async createWallet(input: CreateWalletInput): Promise<CircleWalletInfo> {
    const res = await this.request('POST', '/v1/w3s/developer/wallets', {
      body: {
        idempotencyKey: input.idempotencyKey,
        entitySecretCiphertext: await this.entitySecretCiphertext(),
        walletSetId: input.walletSetId,
        blockchains: [input.blockchain],
        count: 1,
        // SCA обязательно указывать явно: по умолчанию Circle создаёт EOA, которому нужен ETH на газ (ADR-0002).
        accountType: 'SCA',
        metadata: [{ name: input.name, refId: input.refId }],
      },
      schema: CreateWalletsResponseSchema,
    });
    const wallet = res.body.data.wallets[0]!;
    return { id: wallet.id, address: wallet.address, blockchain: wallet.blockchain, state: wallet.state };
  }

  async getWallet(walletId: string): Promise<CircleWalletInfo> {
    const res = await this.request('GET', `/v1/w3s/wallets/${encodeURIComponent(walletId)}`, {
      schema: GetWalletResponseSchema,
    });
    const w = res.body.data.wallet;
    return { id: w.id, address: w.address, blockchain: w.blockchain, state: w.state };
  }

  async getWalletBalances(walletId: string): Promise<WalletTokenBalance[]> {
    const res = await this.request('GET', `/v1/w3s/wallets/${encodeURIComponent(walletId)}/balances`, {
      schema: WalletBalancesResponseSchema,
    });
    return res.body.data.tokenBalances.map((b) => ({ tokenId: b.token.id, amount: b.amount }));
  }

  // -------------------------------------------------------------------------
  // Транзакции
  // -------------------------------------------------------------------------

  async createTransfer(input: CreateTransferInput): Promise<{ id: string; state: string }> {
    const res = await this.request('POST', '/v1/w3s/developer/transactions/transfer', {
      body: {
        idempotencyKey: input.idempotencyKey,
        entitySecretCiphertext: await this.entitySecretCiphertext(),
        walletId: input.walletId,
        tokenId: input.tokenId,
        destinationAddress: input.destinationAddress,
        amounts: [input.amount],
        // Для SCA feeLevel обязателен (ошибка 155232 без него); газ спонсирует Gas Station.
        feeLevel: 'MEDIUM',
        refId: input.refId,
      },
      schema: CreateTransferResponseSchema,
    });
    return res.body.data;
  }

  async getTransaction(id: string, txType: CircleTxType): Promise<CircleTransaction> {
    const res = await this.request('GET', `/v1/w3s/transactions/${encodeURIComponent(id)}`, {
      query: { txType },
      schema: GetTransactionResponseSchema,
    });
    return normalizeRestTransaction(res.body.data.transaction);
  }

  async listTransactions(filter: ListTransactionsFilter): Promise<TransactionsPage> {
    const res = await this.request('GET', '/v1/w3s/transactions', {
      query: {
        walletIds: filter.walletIds?.join(','),
        txType: filter.txType,
        refId: filter.refId,
        from: filter.from,
        pageAfter: filter.pageAfter,
        pageSize: filter.pageSize ?? 50,
      },
      schema: ListTransactionsResponseSchema,
    });
    return {
      items: res.body.data.transactions.map(normalizeRestTransaction),
      nextPageAfter: parseNextPageAfter(res.headers.get('link')),
    };
  }

  // -------------------------------------------------------------------------
  // Вебхуки (notifications v2)
  // -------------------------------------------------------------------------

  async getNotificationPublicKey(keyId: string): Promise<NotificationPublicKey> {
    const res = await this.request('GET', `/v2/notifications/publicKey/${encodeURIComponent(keyId)}`, {
      schema: NotificationPublicKeyResponseSchema,
    });
    return res.body.data;
  }

  async listSubscriptions(): Promise<CircleSubscription[]> {
    const res = await this.request('GET', '/v2/notifications/subscriptions', {
      schema: SubscriptionListResponseSchema,
    });
    return res.body.data;
  }

  async createSubscription(input: { endpoint: string; notificationTypes: string[] }): Promise<CircleSubscription> {
    const res = await this.request('POST', '/v2/notifications/subscriptions', {
      body: input,
      schema: SubscriptionResponseSchema,
    });
    return res.body.data;
  }

  async deleteSubscription(id: string): Promise<void> {
    await this.request('DELETE', `/v2/notifications/subscriptions/${encodeURIComponent(id)}`, {});
  }

  // -------------------------------------------------------------------------
  // Внутреннее
  // -------------------------------------------------------------------------

  /** Новый ciphertext на каждый вызов; публичный ключ entity кешируется (он статичен). */
  private async entitySecretCiphertext(): Promise<string> {
    if (!this.entityPublicKey) {
      this.entityPublicKey = this.request('GET', '/v1/w3s/config/entity/publicKey', {
        schema: EntityPublicKeyResponseSchema,
      }).then((res) => parseEntityPublicKey(res.body.data.publicKey));
      // Неудачную загрузку не кешируем, иначе одна сетевая ошибка сломает все последующие запросы.
      this.entityPublicKey.catch(() => {
        this.entityPublicKey = null;
      });
    }
    return encryptEntitySecret(await this.entityPublicKey, this.options.entitySecret);
  }

  private async request<S extends z.ZodType>(
    method: HttpMethod,
    path: string,
    opts: RequestOptions<S>,
  ): Promise<{ body: z.infer<S>; headers: Headers; status: number }> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    // X-Request-Id (UUID) Circle возвращает в ответе — по нему можно найти запрос в их поддержке.
    const requestId = randomUUID();
    const log = this.options.logger.child({ circle: { method, path, requestId } });

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          Accept: 'application/json',
          'X-Request-Id': requestId,
          ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      // Сеть / DNS / таймаут: ответа не было — исход неизвестен (запрос мог дойти до Circle).
      log.warn({ err: error }, 'Circle request failed without response');
      throw new CircleApiError(`Circle ${method} ${path}: ${(error as Error).message}`, { method, path });
    }

    const text = await response.text();
    const json = text ? safeJsonParse(text) : undefined;

    if (!response.ok) {
      const body = CircleErrorBodySchema.safeParse(json);
      const code = body.success ? body.data.code : undefined;
      const message = (body.success && body.data.message) || response.statusText;
      log.warn({ status: response.status, code, message }, 'Circle request rejected');
      throw new CircleApiError(`Circle ${method} ${path} → ${response.status}${code ? ` (${code})` : ''}: ${message}`, {
        method,
        path,
        status: response.status,
        ...(code !== undefined ? { code } : {}),
      });
    }

    if (!opts.schema) {
      return { body: undefined as z.infer<S>, headers: response.headers, status: response.status };
    }
    const parsed = opts.schema.safeParse(json);
    if (!parsed.success) {
      // Ответ 2xx, но не той формы. Для мутаций это «исход неизвестен»: операция могла выполниться.
      log.error({ status: response.status, issues: parsed.error.issues }, 'Circle response contract violation');
      throw new CircleApiError(`Circle ${method} ${path}: unexpected response shape`, {
        method,
        path,
        status: response.status,
        contractViolation: true,
      });
    }
    return { body: parsed.data, headers: response.headers, status: response.status };
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Circle отдаёт следующую страницу в заголовке Link с АБСОЛЮТНЫМ URL на api.circle.com.
 * Сам URL не используем (иначе мок за CIRCLE_BASE_URL будет обойдён) — достаём только курсор pageAfter.
 */
export function parseNextPageAfter(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part);
    if (!match?.[1]) continue;
    try {
      return new URL(match[1], 'http://placeholder').searchParams.get('pageAfter');
    } catch {
      return null;
    }
  }
  return null;
}

const emptyToNull = (v: string | null | undefined): string | null => (v === undefined || v === null || v === '' ? null : v);

export function normalizeRestTransaction(tx: CircleRestTransaction): CircleTransaction {
  return {
    id: tx.id,
    transactionType: tx.transactionType,
    state: tx.state,
    walletId: emptyToNull(tx.walletId),
    tokenId: emptyToNull(tx.tokenId),
    amount: tx.amounts?.[0] ?? null,
    txHash: emptyToNull(tx.txHash),
    refId: emptyToNull(tx.refId),
    sourceAddress: emptyToNull(tx.sourceAddress)?.toLowerCase() ?? null,
    destinationAddress: emptyToNull(tx.destinationAddress)?.toLowerCase() ?? null,
    errorReason: emptyToNull(tx.errorReason),
    errorDetails: emptyToNull(tx.errorDetails),
  };
}

/** Нормализация вебхука в тот же формат, что и REST: один код применения для вебхуков и reconciliation. */
export function normalizeNotificationTransaction(tx: {
  id: string;
  transactionType: CircleTxType;
  state: string;
  walletId: string;
  tokenId?: string | null | undefined;
  amounts?: string[] | null | undefined;
  txHash?: string | null | undefined;
  refId?: string | null | undefined;
  sourceAddress?: string | null | undefined;
  destinationAddress?: string | null | undefined;
  errorReason?: string | null | undefined;
  errorDetails?: string | null | undefined;
}): CircleTransaction {
  return {
    id: tx.id,
    transactionType: tx.transactionType,
    state: tx.state,
    walletId: tx.walletId,
    tokenId: emptyToNull(tx.tokenId),
    amount: tx.amounts?.[0] ?? null,
    txHash: emptyToNull(tx.txHash),
    refId: emptyToNull(tx.refId),
    sourceAddress: emptyToNull(tx.sourceAddress)?.toLowerCase() ?? null,
    destinationAddress: emptyToNull(tx.destinationAddress)?.toLowerCase() ?? null,
    errorReason: emptyToNull(tx.errorReason),
    errorDetails: emptyToNull(tx.errorDetails),
  };
}
