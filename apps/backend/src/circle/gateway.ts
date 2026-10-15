/**
 * Порт (интерфейс) к Circle, от которого зависит доменный код.
 *
 * Домен не знает ни про HTTP, ни про entity secret: только «создай кошелёк», «переведи», «покажи транзакцию».
 * Реализация — CircleClient (свой тонкий клиент на fetch), в тестах — FakeCircleGateway.
 * Основной денежный поток опирается только на createWallet / createTransfer / getTransaction
 * и публичный ключ вебхуков; остальные методы нужны reconciliation и деградируют мягко.
 */

export type CircleTxType = 'INBOUND' | 'OUTBOUND';

/** Нормализованная транзакция Circle: один формат и для REST, и для вебхуков. */
export interface CircleTransaction {
  id: string;
  transactionType: CircleTxType;
  state: string;
  walletId: string | null;
  tokenId: string | null;
  /** Сумма в единицах токена (десятичная строка), как её отдаёт Circle. Для ERC-20 переводов — ровно одна. */
  amount: string | null;
  txHash: string | null;
  refId: string | null;
  sourceAddress: string | null;
  destinationAddress: string | null;
  /** null — ошибки нет (REST опускает поле, вебхук присылает "" — нормализуем в null). */
  errorReason: string | null;
  errorDetails: string | null;
}

export interface CircleWalletInfo {
  id: string;
  address: string;
  blockchain: string;
  state: string;
}

export interface CreateWalletInput {
  idempotencyKey: string;
  walletSetId: string;
  blockchain: string;
  name: string;
  refId: string;
}

export interface CreateTransferInput {
  idempotencyKey: string;
  walletId: string;
  tokenId: string;
  destinationAddress: string;
  /** Десятичная строка в единицах токена. */
  amount: string;
  refId: string;
}

export interface ListTransactionsFilter {
  walletIds?: string[];
  txType?: CircleTxType;
  refId?: string;
  /** ISO-8601, включительно. */
  from?: string;
  pageAfter?: string;
  pageSize?: number;
}

export interface TransactionsPage {
  items: CircleTransaction[];
  nextPageAfter: string | null;
}

export interface WalletTokenBalance {
  tokenId: string;
  /** Десятичная строка в единицах токена. */
  amount: string;
}

export interface NotificationPublicKey {
  id: string;
  algorithm: string;
  /** base64 DER SPKI. */
  publicKey: string;
}

export interface CircleGateway {
  createWallet(input: CreateWalletInput): Promise<CircleWalletInfo>;
  getWallet(walletId: string): Promise<CircleWalletInfo>;
  createTransfer(input: CreateTransferInput): Promise<{ id: string; state: string }>;
  /**
   * txType обязателен: у внутреннего перевода (sweep, вывод на deposit-адрес другого пользователя)
   * OUTBOUND- и INBOUND-ноги могут иметь один и тот же id — без txType можно применить не ту ногу.
   */
  getTransaction(id: string, txType: CircleTxType): Promise<CircleTransaction>;
  listTransactions(filter: ListTransactionsFilter): Promise<TransactionsPage>;
  getWalletBalances(walletId: string): Promise<WalletTokenBalance[]>;
  getNotificationPublicKey(keyId: string): Promise<NotificationPublicKey>;
}
