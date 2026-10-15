/**
 * Подготовка Circle: wallet set и treasury-кошелёк (общий hot wallet, ADR-0001).
 *
 *   pnpm circle:bootstrap
 *
 * Идемпотентно по .env: если CIRCLE_WALLET_SET_ID / CIRCLE_TREASURY_WALLET_ID уже заданы, ничего не создаёт.
 * Созданные id записываются в корневой .env. Строку treasury в БД создаёт сам api/worker при старте
 * (ensureTreasuryWallet), поэтому скрипту база не нужна.
 */
import { randomUUID } from 'node:crypto';
import { createCircleClient } from '../src/circle';
import { loadCircleConfig } from '../src/config';
import { createLogger } from '../src/lib/logger';
import { upsertEnvValues } from './lib/env-file';

const config = loadCircleConfig();
const circle = createCircleClient(createLogger('bootstrap'), config);

let walletSetId = config.CIRCLE_WALLET_SET_ID;
if (walletSetId) {
  console.log(`Wallet set уже задан: ${walletSetId}`);
} else {
  ({ id: walletSetId } = await circle.createWalletSet({ idempotencyKey: randomUUID(), name: 'circle-wallet' }));
  upsertEnvValues({ CIRCLE_WALLET_SET_ID: walletSetId });
  console.log(`Создан wallet set: ${walletSetId} (записан в .env)`);
}

let treasuryId = config.CIRCLE_TREASURY_WALLET_ID;
if (treasuryId) {
  console.log(`Treasury уже задан: ${treasuryId}`);
} else {
  const wallet = await circle.createWallet({
    idempotencyKey: randomUUID(),
    walletSetId,
    blockchain: config.CIRCLE_BLOCKCHAIN,
    name: 'treasury',
    refId: 'treasury',
  });
  treasuryId = wallet.id;
  upsertEnvValues({ CIRCLE_TREASURY_WALLET_ID: treasuryId });
  console.log(`Создан treasury-кошелёк (SCA): ${treasuryId} (записан в .env)`);
}

const treasury = await circle.getWallet(treasuryId);
console.log(`\nTreasury address (${treasury.blockchain}): ${treasury.address}`);
console.log('Для house float пополните этот адрес на https://faucet.circle.com (сеть Base Sepolia, USDC/EURC).');
