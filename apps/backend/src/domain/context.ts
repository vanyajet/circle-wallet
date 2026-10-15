import type { CircleGateway } from '../circle/gateway';
import type { Db } from '../db/client';
import type { Logger } from '../lib/logger';
import type { TokenRegistry } from './tokens';

/** Зависимости доменного кода. Собираются в entrypoint'ах, в тестах подменяются (FakeCircleGateway и т.п.). */
export interface AppContext {
  db: Db;
  circle: CircleGateway;
  tokens: TokenRegistry;
  logger: Logger;
  settings: {
    blockchain: string;
    /** Wallet set, в котором создаются deposit-кошельки (заполняет pnpm circle:bootstrap). */
    walletSetId: string | undefined;
    /** Circle id treasury-кошелька (заполняет pnpm circle:bootstrap). */
    treasuryCircleWalletId: string | undefined;
    /** Порог sweep в единицах токена (десятичная строка). */
    sweepMinAmount: string;
  };
}

/** Ошибка «повторить позже»: событие пока нельзя применить (например, вебхук пришёл раньше ответа Circle). */
export class RetryLaterError extends Error {
  constructor(
    message: string,
    readonly delayMs = 10_000,
  ) {
    super(message);
    this.name = 'RetryLaterError';
  }
}
