/**
 * Фейковый Circle для интеграционных тестов: детерминированный, без сети.
 * Повторяет важные для нас свойства настоящего API: идемпотентность по idempotencyKey,
 * поиск по refId, раздельные ноги INBOUND/OUTBOUND.
 */
import { randomUUID } from 'node:crypto';
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
} from '../../src/circle/gateway';

export class FakeCircleGateway implements CircleGateway {
  readonly wallets = new Map<string, CircleWalletInfo>();
  readonly walletsByKey = new Map<string, CircleWalletInfo>();
  readonly transfers = new Map<string, { input: CreateTransferInput; id: string }>();
  readonly transactions = new Map<string, CircleTransaction>();
  createTransferCalls = 0;
  /** Следующие N вызовов createTransfer «потеряют ответ»: перевод создан, но клиент получает ошибку сети. */
  dropNextTransferResponses = 0;
  /** Ошибка, которую бросит следующий createTransfer (до создания перевода). */
  failNextTransferWith: Error | null = null;
  /** Поиск транзакций недоступен (например, мок без list-эндпоинта). */
  listFails = false;

  registerWallet(wallet: CircleWalletInfo): void {
    this.wallets.set(wallet.id, wallet);
  }

  async createWallet(input: CreateWalletInput): Promise<CircleWalletInfo> {
    const existing = this.walletsByKey.get(input.idempotencyKey);
    if (existing) return existing;
    const wallet: CircleWalletInfo = {
      id: randomUUID(),
      address: `0x${randomUUID().replaceAll('-', '').padEnd(40, '0').slice(0, 40)}`,
      blockchain: input.blockchain,
      state: 'LIVE',
    };
    this.walletsByKey.set(input.idempotencyKey, wallet);
    this.wallets.set(wallet.id, wallet);
    return wallet;
  }

  async getWallet(walletId: string): Promise<CircleWalletInfo> {
    const wallet = this.wallets.get(walletId);
    if (!wallet) throw new Error(`wallet ${walletId} not found`);
    return wallet;
  }

  async createTransfer(input: CreateTransferInput): Promise<{ id: string; state: string }> {
    this.createTransferCalls++;
    if (this.failNextTransferWith) {
      const error = this.failNextTransferWith;
      this.failNextTransferWith = null;
      throw error;
    }
    let transfer = this.transfers.get(input.idempotencyKey);
    if (!transfer) {
      transfer = { input, id: randomUUID() };
      this.transfers.set(input.idempotencyKey, transfer);
      this.transactions.set(`${transfer.id}:OUTBOUND`, {
        id: transfer.id,
        transactionType: 'OUTBOUND',
        state: 'INITIATED',
        walletId: input.walletId,
        tokenId: input.tokenId,
        amount: input.amount,
        txHash: null,
        refId: input.refId,
        sourceAddress: this.wallets.get(input.walletId)?.address ?? null,
        destinationAddress: input.destinationAddress,
        errorReason: null,
        errorDetails: null,
      });
    }
    if (this.dropNextTransferResponses > 0) {
      this.dropNextTransferResponses--;
      throw Object.assign(new Error('socket hang up'), { name: 'FetchError' });
    }
    // Повтор с тем же ключом возвращает существующую транзакцию в её ТЕКУЩЕМ состоянии (как 200 у Circle).
    return { id: transfer.id, state: this.transactions.get(`${transfer.id}:OUTBOUND`)!.state };
  }

  /** Сымитировать изменение состояния транзакции в Circle (то, о чём потом придёт вебхук). */
  setState(id: string, txType: CircleTxType, patch: Partial<CircleTransaction>): CircleTransaction {
    const key = `${id}:${txType}`;
    const tx = this.transactions.get(key);
    if (!tx) throw new Error(`tx ${key} not found`);
    const updated = { ...tx, ...patch };
    this.transactions.set(key, updated);
    return updated;
  }

  addInbound(tx: Omit<CircleTransaction, 'transactionType'>): CircleTransaction {
    const full: CircleTransaction = { ...tx, transactionType: 'INBOUND' };
    this.transactions.set(`${tx.id}:INBOUND`, full);
    return full;
  }

  async getTransaction(id: string, txType: CircleTxType): Promise<CircleTransaction> {
    const tx = this.transactions.get(`${id}:${txType}`);
    if (!tx) throw new Error(`tx ${id}:${txType} not found`);
    return tx;
  }

  async listTransactions(filter: ListTransactionsFilter): Promise<TransactionsPage> {
    if (this.listFails) throw new Error('list transactions unavailable');
    const items = [...this.transactions.values()].filter(
      (t) =>
        (!filter.txType || t.transactionType === filter.txType) &&
        (!filter.refId || t.refId === filter.refId) &&
        (!filter.walletIds || (t.walletId && filter.walletIds.includes(t.walletId))),
    );
    return { items, nextPageAfter: null };
  }

  async getWalletBalances(): Promise<WalletTokenBalance[]> {
    return [];
  }

  async getNotificationPublicKey(): Promise<NotificationPublicKey> {
    throw new Error('not used in tests');
  }
}
