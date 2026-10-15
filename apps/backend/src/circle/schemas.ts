/**
 * zod-схемы ответов Circle и вебхуков.
 *
 * Мы валидируем ответы внешнего API: если Circle (или мок за CIRCLE_BASE_URL) вернёт не то, что мы ждём,
 * лучше упасть с понятной ошибкой «contract violation», чем записать в леджер NaN.
 * Состояния транзакций принимаем как строку, а не enum: если Circle добавит новое состояние,
 * state machine его проигнорирует, а не уронит обработку (см. domain/circle-state.ts).
 */
import { z } from 'zod';

const nullishString = z.string().nullish();

export const CircleWalletSchema = z.object({
  id: z.string(),
  address: z.string(),
  blockchain: z.string(),
  state: z.string(),
  walletSetId: z.string().nullish(),
  accountType: z.string().nullish(),
  refId: nullishString,
  name: nullishString,
});
export type CircleWallet = z.infer<typeof CircleWalletSchema>;

/** Транзакция из REST (GET /v1/w3s/transactions[/{id}]). Обязательны только id/state/blockchain/transactionType. */
export const CircleRestTransactionSchema = z.object({
  id: z.string(),
  state: z.string(),
  blockchain: z.string(),
  transactionType: z.enum(['INBOUND', 'OUTBOUND']),
  walletId: nullishString,
  tokenId: nullishString,
  amounts: z.array(z.string()).nullish(),
  txHash: nullishString,
  refId: nullishString,
  sourceAddress: nullishString,
  destinationAddress: nullishString,
  // В REST errorReason есть только у FAILED, errorDetails — строка или отсутствует.
  errorReason: nullishString,
  errorDetails: nullishString,
  createDate: z.string(),
  updateDate: z.string(),
});
export type CircleRestTransaction = z.infer<typeof CircleRestTransactionSchema>;

/**
 * Транзакция из вебхука transactions.inbound / transactions.outbound. Payload урезан по сравнению с REST,
 * зато errorReason присутствует всегда ("" — нет ошибки), а errorDetails — null.
 * Inbound-события могут приходить без sourceAddress / txHash / refId.
 */
export const CircleTransactionNotificationSchema = z.object({
  id: z.string(),
  state: z.string(),
  blockchain: z.string(),
  transactionType: z.enum(['INBOUND', 'OUTBOUND']),
  walletId: z.string(),
  tokenId: nullishString,
  amounts: z.array(z.string()).nullish(),
  txHash: nullishString,
  refId: nullishString,
  sourceAddress: nullishString,
  destinationAddress: nullishString,
  errorReason: nullishString,
  errorDetails: nullishString,
  createDate: nullishString,
  updateDate: nullishString,
});

/** Конверт v2-вебхука. Все шесть полей обязательны по спецификации. */
export const NotificationEnvelopeSchema = z.object({
  subscriptionId: z.string(),
  notificationId: z.string(),
  notificationType: z.string(),
  notification: z.unknown(),
  timestamp: z.string(),
  version: z.number(),
});
export type NotificationEnvelope = z.infer<typeof NotificationEnvelopeSchema>;

export const CircleErrorBodySchema = z.object({
  code: z.number().optional(),
  message: z.string().optional(),
});

export const EntityPublicKeyResponseSchema = z.object({ data: z.object({ publicKey: z.string() }) });

export const WalletSetResponseSchema = z.object({
  data: z.object({ walletSet: z.object({ id: z.string() }) }),
});

export const CreateWalletsResponseSchema = z.object({
  data: z.object({ wallets: z.array(CircleWalletSchema).min(1) }),
});

export const GetWalletResponseSchema = z.object({ data: z.object({ wallet: CircleWalletSchema }) });

export const CreateTransferResponseSchema = z.object({
  data: z.object({ id: z.string(), state: z.string() }),
});

export const GetTransactionResponseSchema = z.object({
  data: z.object({ transaction: CircleRestTransactionSchema }),
});

export const ListTransactionsResponseSchema = z.object({
  data: z.object({ transactions: z.array(CircleRestTransactionSchema) }),
});

export const WalletBalancesResponseSchema = z.object({
  data: z.object({
    tokenBalances: z.array(
      z.object({
        amount: z.string(),
        token: z.object({
          id: z.string(),
          symbol: nullishString,
          decimals: z.number().nullish(),
          tokenAddress: nullishString,
          isNative: z.boolean().nullish(),
        }),
      }),
    ),
  }),
});

export const NotificationPublicKeyResponseSchema = z.object({
  data: z.object({ id: z.string(), algorithm: z.string(), publicKey: z.string() }),
});

export const SubscriptionSchema = z.object({
  id: z.string(),
  endpoint: z.string(),
  enabled: z.boolean().nullish(),
  notificationTypes: z.array(z.string()).nullish(),
});
export type CircleSubscription = z.infer<typeof SubscriptionSchema>;

export const SubscriptionResponseSchema = z.object({ data: SubscriptionSchema });
export const SubscriptionListResponseSchema = z.object({ data: z.array(SubscriptionSchema) });
