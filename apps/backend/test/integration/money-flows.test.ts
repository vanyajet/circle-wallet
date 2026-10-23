/**
 * Интеграционные тесты денежных потоков на настоящем Postgres (миграции + триггеры) и фейковом Circle.
 * Проверяют то, о чём спросят на ревью в первую очередь: double-spend, идемпотентность, порядок
 * и дубли вебхуков, потерянный ответ Circle, ликвидность treasury, sweep vs house float,
 * переводы по UID (атомарность, встречные переводы без deadlock).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CircleApiError } from '../../src/circle/errors';
import type { CircleTransaction } from '../../src/circle/gateway';
import { applyCircleTransaction } from '../../src/domain/circle-events';
import { getAccountBalance, custody, house, userAvailable, userHeld } from '../../src/domain/ledger';
import { listOperations } from '../../src/domain/operations';
import { getOpsOverview } from '../../src/domain/ops';
import { runSweep } from '../../src/domain/sweeps';
import { createInternalTransfer, getTransferRecipient } from '../../src/domain/transfers';
import { classifyTreasuryInbound } from '../../src/domain/treasury';
import { createUser } from '../../src/domain/users';
import { createDepositWallet, ensureTreasuryWallet, requireTreasuryWallet } from '../../src/domain/wallets';
import { createWithdrawal, submitWithdrawal } from '../../src/domain/withdrawals';
import { AppError } from '../../src/lib/errors';
import { startTestEnv, USDC_TOKEN_ID, type TestEnv } from '../helpers/test-db';

const EURC_TOKEN_ID = '5b1ba740-7bb7-5695-bd2b-09243ce0f079';
const EXTERNAL = '0x1111111111111111111111111111111111111111';
const usdc = (v: string) => BigInt(Math.round(Number(v) * 1e6));

let env: TestEnv;

beforeAll(async () => {
  env = await startTestEnv();
  await ensureTreasuryWallet(env.ctx);
});

afterAll(async () => {
  await env?.stop();
});

async function newUserWithWallet(name = 'user') {
  const user = await createUser(env.ctx, name);
  const wallet = await env.db.selectFrom('app.wallets').selectAll().where('user_id', '=', user.id).executeTakeFirstOrThrow();
  await createDepositWallet(env.ctx, wallet.id);
  const active = await env.db.selectFrom('app.wallets').selectAll().where('id', '=', wallet.id).executeTakeFirstOrThrow();
  return { userId: user.id, wallet: active };
}

function inbound(walletCircleId: string, amount: string, state: string, overrides: Partial<CircleTransaction> = {}): CircleTransaction {
  return {
    id: overrides.id ?? randomUUID(),
    transactionType: 'INBOUND',
    state,
    walletId: walletCircleId,
    tokenId: USDC_TOKEN_ID,
    amount,
    txHash: null,
    refId: null,
    sourceAddress: EXTERNAL,
    destinationAddress: null,
    errorReason: null,
    errorDetails: null,
    ...overrides,
  };
}

async function deposit(walletCircleId: string, amount: string, tokenId = USDC_TOKEN_ID) {
  const id = randomUUID();
  await applyCircleTransaction(env.ctx, inbound(walletCircleId, amount, 'CONFIRMED', { id, tokenId }), 'webhook');
  await applyCircleTransaction(env.ctx, inbound(walletCircleId, amount, 'COMPLETE', { id, tokenId }), 'webhook');
  return id;
}

async function fundHouse(amount: string, tokenId = USDC_TOKEN_ID) {
  const treasury = await requireTreasuryWallet(env.db);
  const tx = env.circle.addInbound(inbound(treasury.circle_wallet_id, amount, 'COMPLETE', { tokenId }));
  await applyCircleTransaction(env.ctx, tx, 'webhook');
  const row = await env.db
    .selectFrom('app.treasury_inbounds')
    .select('id')
    .where('circle_transaction_id', '=', tx.id)
    .executeTakeFirstOrThrow();
  return classifyTreasuryInbound(env.ctx, row.id);
}

async function expectLedgerBalanced() {
  const overview = await getOpsOverview(env.ctx);
  for (const t of overview.tokens) expect(t.ledgerBalanced, `ledger identity for ${t.token}`).toBe(true);
}

describe('ликвидность treasury (EURC, пустой treasury)', () => {
  it('вывод ждёт ликвидности, уходит после house float и проводится на COMPLETE', async () => {
    const { userId, wallet } = await newUserWithWallet('liquidity');
    await deposit(wallet.circle_wallet_id!, '10', EURC_TOKEN_ID);

    const { withdrawal } = await createWithdrawal(env.ctx, userId, randomUUID(), {
      token: 'EURC',
      amount: '4',
      destinationAddress: EXTERNAL,
    });
    // Treasury пуст (депозит ещё не сметён) — вывод не падает, а ждёт.
    expect(await submitWithdrawal(env.ctx, withdrawal.id)).toEqual({ type: 'wait_liquidity' });
    const waiting = await env.db.selectFrom('app.withdrawals').selectAll().where('id', '=', withdrawal.id).executeTakeFirstOrThrow();
    expect(waiting.status).toBe('PENDING');
    expect(waiting.awaiting_liquidity).toBe(true);

    // House float: стороннее поступление на treasury → HOUSE_FUNDING.
    expect(await fundHouse('5', EURC_TOKEN_ID)).toEqual({ type: 'done', result: 'HOUSE_FUNDING' });
    expect(await getAccountBalance(env.db, house('EURC'))).toBe(5_000_000n);

    expect(await submitWithdrawal(env.ctx, withdrawal.id)).toEqual({ type: 'done', result: 'SUBMITTED' });
    const submitted = await env.db.selectFrom('app.withdrawals').selectAll().where('id', '=', withdrawal.id).executeTakeFirstOrThrow();
    expect(submitted.status).toBe('SUBMITTED');

    const done = env.circle.setState(submitted.circle_transaction_id!, 'OUTBOUND', { state: 'COMPLETE', txHash: '0xabc' });
    expect(await applyCircleTransaction(env.ctx, done, 'webhook')).toBe('APPLIED:COMPLETED');

    expect(await getAccountBalance(env.db, userAvailable(userId, 'EURC'))).toBe(6_000_000n);
    expect(await getAccountBalance(env.db, userHeld(userId, 'EURC'))).toBe(0n);
    const treasury = await requireTreasuryWallet(env.db);
    expect(await getAccountBalance(env.db, custody(treasury.id, 'EURC'))).toBe(1_000_000n);
    await expectLedgerBalanced();
  });
});

describe('депозиты', () => {
  it('зачисляет ровно один раз при дублях и неправильном порядке вебхуков', async () => {
    const { userId, wallet } = await newUserWithWallet('dup');
    const id = randomUUID();
    const w = wallet.circle_wallet_id!;
    // CONFIRMED → COMPLETE → COMPLETE (дубль) → CONFIRMED (опоздал).
    await applyCircleTransaction(env.ctx, inbound(w, '7.5', 'CONFIRMED', { id }), 'webhook');
    expect(await getAccountBalance(env.db, userAvailable(userId, 'USDC'))).toBe(0n);
    await applyCircleTransaction(env.ctx, inbound(w, '7.5', 'COMPLETE', { id }), 'webhook');
    await applyCircleTransaction(env.ctx, inbound(w, '7.5', 'COMPLETE', { id }), 'reconcile');
    await applyCircleTransaction(env.ctx, inbound(w, '7.5', 'CONFIRMED', { id }), 'webhook');

    expect(await getAccountBalance(env.db, userAvailable(userId, 'USDC'))).toBe(usdc('7.5'));
    const dep = await env.db.selectFrom('app.deposits').selectAll().where('circle_transaction_id', '=', id).executeTakeFirstOrThrow();
    expect(dep.status).toBe('COMPLETED');
    expect(dep.circle_state).toBe('COMPLETE');
    const credits = await env.db
      .selectFrom('app.ledger_transactions')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('kind', '=', 'DEPOSIT_CREDIT')
      .where('reference_id', '=', dep.id)
      .executeTakeFirstOrThrow();
    expect(credits.n).toBe(1);
    // Вместе с зачислением поставлен sweep (outbox).
    const sweepJob = await env.db
      .selectFrom('app.jobs')
      .select('id')
      .where('dedupe_key', '=', `sweep:${wallet.id}:USDC`)
      .executeTakeFirst();
    expect(sweepJob).toBeDefined();
    await expectLedgerBalanced();
  });

  it('не зачисляет FAILED-депозит и игнорирует токены вне allowlist', async () => {
    const { userId, wallet } = await newUserWithWallet('failed');
    const id = randomUUID();
    await applyCircleTransaction(env.ctx, inbound(wallet.circle_wallet_id!, '3', 'CONFIRMED', { id }), 'webhook');
    await applyCircleTransaction(env.ctx, inbound(wallet.circle_wallet_id!, '3', 'FAILED', { id, errorReason: 'FAILED_REORG' }), 'webhook');
    // Поздний COMPLETE после FAILED не должен ничего зачислить: терминальное состояние не меняется.
    await applyCircleTransaction(env.ctx, inbound(wallet.circle_wallet_id!, '3', 'COMPLETE', { id }), 'webhook');
    expect(await getAccountBalance(env.db, userAvailable(userId, 'USDC'))).toBe(0n);

    const spam = await applyCircleTransaction(
      env.ctx,
      inbound(wallet.circle_wallet_id!, '1000', 'COMPLETE', { tokenId: randomUUID() }),
      'webhook',
    );
    expect(spam).toMatch(/^IGNORED:unsupported_token/);
  });
});

describe('выводы', () => {
  it('параллельные выводы не могут потратить больше баланса (double-spend)', async () => {
    const { userId, wallet } = await newUserWithWallet('race');
    await deposit(wallet.circle_wallet_id!, '10');

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        createWithdrawal(env.ctx, userId, randomUUID(), { token: 'USDC', amount: '3', destinationAddress: EXTERNAL }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(3);
    expect(rejected).toHaveLength(3);
    for (const r of rejected) expect((r.reason as AppError).code).toBe('INSUFFICIENT_FUNDS');

    expect(await getAccountBalance(env.db, userAvailable(userId, 'USDC'))).toBe(usdc('1'));
    expect(await getAccountBalance(env.db, userHeld(userId, 'USDC'))).toBe(usdc('9'));
    await expectLedgerBalanced();
  });

  it('Idempotency-Key: повтор возвращает тот же вывод, другое тело — 409', async () => {
    const { userId, wallet } = await newUserWithWallet('idem');
    await deposit(wallet.circle_wallet_id!, '5');
    const key = randomUUID();
    const body = { token: 'USDC', amount: '2', destinationAddress: EXTERNAL };

    const [a, b] = await Promise.all([createWithdrawal(env.ctx, userId, key, body), createWithdrawal(env.ctx, userId, key, body)]);
    expect(a.withdrawal.id).toBe(b.withdrawal.id);
    expect(await getAccountBalance(env.db, userHeld(userId, 'USDC'))).toBe(usdc('2'));

    await expect(createWithdrawal(env.ctx, userId, key, { ...body, amount: '3' })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('параллельный повтор с тем же ключом на весь баланс возвращает тот же вывод, а не 422', async () => {
    const { userId, wallet } = await newUserWithWallet('idem-full');
    await deposit(wallet.circle_wallet_id!, '5');
    const key = randomUUID();
    const body = { token: 'USDC', amount: '5', destinationAddress: EXTERNAL };
    const results = await Promise.all(Array.from({ length: 3 }, () => createWithdrawal(env.ctx, userId, key, body)));
    expect(new Set(results.map((r) => r.withdrawal.id)).size).toBe(1);
    expect(await getAccountBalance(env.db, userHeld(userId, 'USDC'))).toBe(usdc('5'));
  });

  it('отклоняет опасные адреса и лишнюю точность суммы', async () => {
    const { userId, wallet } = await newUserWithWallet('validation');
    await deposit(wallet.circle_wallet_id!, '5');
    const treasury = await requireTreasuryWallet(env.db);
    const attempt = (destinationAddress: string, amount = '1') =>
      createWithdrawal(env.ctx, userId, randomUUID(), { token: 'USDC', amount, destinationAddress });

    await expect(attempt('0x0000000000000000000000000000000000000000')).rejects.toMatchObject({ code: 'ADDRESS_NOT_ALLOWED' });
    await expect(attempt('0x036cbd53842c5426634e7929541ec2318f3dcf7e')).rejects.toMatchObject({ code: 'ADDRESS_NOT_ALLOWED' });
    await expect(attempt(treasury.address)).rejects.toMatchObject({ code: 'ADDRESS_NOT_ALLOWED' });
    await expect(attempt(wallet.address!)).rejects.toMatchObject({ code: 'ADDRESS_NOT_ALLOWED' });
    await expect(attempt('0x123')).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
    // Смешанный регистр с неверной EIP-55 checksum.
    await expect(attempt('0x036CbD53842c5426634e7929541eC2318f3dCF7E')).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
    await expect(attempt(EXTERNAL, '0.0000001')).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    await expect(attempt(EXTERNAL, '0')).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
  });

  it('потерянный ответ Circle не приводит ко второму переводу', async () => {
    await fundHouse('100');
    const { userId, wallet } = await newUserWithWallet('lost-response');
    await deposit(wallet.circle_wallet_id!, '5');
    const { withdrawal } = await createWithdrawal(env.ctx, userId, randomUUID(), {
      token: 'USDC',
      amount: '2',
      destinationAddress: EXTERNAL,
    });

    const callsBefore = env.circle.createTransferCalls;
    env.circle.dropNextTransferResponses = 1;
    // Перевод в Circle создан, но ответ потерялся — исход неизвестен, задача упадёт и повторится.
    await expect(submitWithdrawal(env.ctx, withdrawal.id)).rejects.toThrow('socket hang up');
    const stuck = await env.db.selectFrom('app.withdrawals').selectAll().where('id', '=', withdrawal.id).executeTakeFirstOrThrow();
    expect(stuck.status).toBe('SUBMITTING');
    expect(await getAccountBalance(env.db, userHeld(userId, 'USDC'))).toBe(usdc('2'));

    // Повтор: находит перевод по refId и не вызывает createTransfer второй раз.
    expect(await submitWithdrawal(env.ctx, withdrawal.id)).toEqual({ type: 'done', result: 'RECOVERED_BY_REF_ID' });
    expect(env.circle.createTransferCalls - callsBefore).toBe(1);
    const recovered = await env.db.selectFrom('app.withdrawals').selectAll().where('id', '=', withdrawal.id).executeTakeFirstOrThrow();
    expect(recovered.status).toBe('SUBMITTED');
    expect(env.circle.transfers.has(withdrawal.id)).toBe(true);
  });

  it('вебхук раньше ответа Circle сопоставляется по refId; FAILED возвращает средства', async () => {
    const { userId, wallet } = await newUserWithWallet('early-webhook');
    await deposit(wallet.circle_wallet_id!, '5');
    const { withdrawal } = await createWithdrawal(env.ctx, userId, randomUUID(), {
      token: 'USDC',
      amount: '5',
      destinationAddress: EXTERNAL,
    });
    // Ответ Circle «потерялся», но вебхук FAILED пришёл — находим вывод по refId.
    env.circle.dropNextTransferResponses = 1;
    await expect(submitWithdrawal(env.ctx, withdrawal.id)).rejects.toThrow();
    const transfer = env.circle.transfers.get(withdrawal.id)!;
    const failed = env.circle.setState(transfer.id, 'OUTBOUND', { state: 'FAILED', errorReason: 'FAILED_ON_CHAIN' });
    expect(await applyCircleTransaction(env.ctx, failed, 'webhook')).toBe('APPLIED:FAILED');

    expect(await getAccountBalance(env.db, userAvailable(userId, 'USDC'))).toBe(usdc('5'));
    expect(await getAccountBalance(env.db, userHeld(userId, 'USDC'))).toBe(0n);
    // Поздний COMPLETE после FAILED игнорируется — второй раз деньги не спишутся.
    const late = env.circle.setState(transfer.id, 'OUTBOUND', { state: 'COMPLETE' });
    expect(await applyCircleTransaction(env.ctx, late, 'webhook')).toBe('NOOP:FAILED');
    await expectLedgerBalanced();
  });

  it('4xx на ПОВТОРНУЮ отправку не освобождает резерв: первый перевод мог уже уйти', async () => {
    const { userId, wallet } = await newUserWithWallet('resume-4xx');
    await deposit(wallet.circle_wallet_id!, '4');
    const { withdrawal } = await createWithdrawal(env.ctx, userId, randomUUID(), {
      token: 'USDC',
      amount: '4',
      destinationAddress: EXTERNAL,
    });
    env.circle.dropNextTransferResponses = 1;
    await expect(submitWithdrawal(env.ctx, withdrawal.id)).rejects.toThrow();
    // Поиск по refId недоступен, а повтор получает «окончательный» 4xx.
    env.circle.listFails = true;
    env.circle.failNextTransferWith = new CircleApiError('conflict', {
      method: 'POST',
      path: '/v1/w3s/developer/transactions/transfer',
      status: 409,
    });
    try {
      await expect(submitWithdrawal(env.ctx, withdrawal.id)).rejects.toBeInstanceOf(CircleApiError);
    } finally {
      env.circle.listFails = false;
    }
    const row = await env.db.selectFrom('app.withdrawals').selectAll().where('id', '=', withdrawal.id).executeTakeFirstOrThrow();
    expect(row.status).toBe('SUBMITTING');
    expect(await getAccountBalance(env.db, userHeld(userId, 'USDC'))).toBe(usdc('4'));
    expect(await getAccountBalance(env.db, userAvailable(userId, 'USDC'))).toBe(0n);

    // Перевод на самом деле прошёл: вебхук COMPLETE находит вывод по refId и проводит SETTLE.
    const transfer = env.circle.transfers.get(withdrawal.id)!;
    const done = env.circle.setState(transfer.id, 'OUTBOUND', { state: 'COMPLETE' });
    expect(await applyCircleTransaction(env.ctx, done, 'webhook')).toBe('APPLIED:COMPLETED');
    expect(await getAccountBalance(env.db, userHeld(userId, 'USDC'))).toBe(0n);
    await expectLedgerBalanced();
  });

  it('терминальное состояние в ответе на повтор проходит через state machine (вывод не «зависает»)', async () => {
    const { userId, wallet } = await newUserWithWallet('replay-complete');
    await deposit(wallet.circle_wallet_id!, '2');
    const { withdrawal } = await createWithdrawal(env.ctx, userId, randomUUID(), {
      token: 'USDC',
      amount: '2',
      destinationAddress: EXTERNAL,
    });
    env.circle.dropNextTransferResponses = 1;
    await expect(submitWithdrawal(env.ctx, withdrawal.id)).rejects.toThrow();
    // Пока ответ «терялся», перевод в Circle завершился; вебхуки тоже потерялись, поиск по refId недоступен.
    const transfer = env.circle.transfers.get(withdrawal.id)!;
    env.circle.setState(transfer.id, 'OUTBOUND', { state: 'COMPLETE' });
    env.circle.listFails = true;
    try {
      expect(await submitWithdrawal(env.ctx, withdrawal.id)).toEqual({ type: 'done', result: 'SUBMITTED' });
    } finally {
      env.circle.listFails = false;
    }
    const row = await env.db.selectFrom('app.withdrawals').selectAll().where('id', '=', withdrawal.id).executeTakeFirstOrThrow();
    expect(row.status).toBe('COMPLETED');
    expect(await getAccountBalance(env.db, userHeld(userId, 'USDC'))).toBe(0n);
    await expectLedgerBalanced();
  });

  it('явный отказ Circle (4xx) переводит вывод в FAILED и возвращает средства', async () => {
    const { userId, wallet } = await newUserWithWallet('rejected');
    await deposit(wallet.circle_wallet_id!, '3');
    const { withdrawal } = await createWithdrawal(env.ctx, userId, randomUUID(), {
      token: 'USDC',
      amount: '3',
      destinationAddress: EXTERNAL,
    });
    env.circle.failNextTransferWith = new CircleApiError('API parameter invalid', {
      method: 'POST',
      path: '/v1/w3s/developer/transactions/transfer',
      status: 400,
      code: 2,
    });
    expect(await submitWithdrawal(env.ctx, withdrawal.id)).toEqual({ type: 'done', result: 'FAILED:rejected' });
    expect(await getAccountBalance(env.db, userAvailable(userId, 'USDC'))).toBe(usdc('3'));
  });

  it('временная ошибка Circle (429) не освобождает резерв', async () => {
    const { userId, wallet } = await newUserWithWallet('rate-limited');
    await deposit(wallet.circle_wallet_id!, '3');
    const { withdrawal } = await createWithdrawal(env.ctx, userId, randomUUID(), {
      token: 'USDC',
      amount: '1',
      destinationAddress: EXTERNAL,
    });
    env.circle.failNextTransferWith = new CircleApiError('Too Many Requests', {
      method: 'POST',
      path: '/v1/w3s/developer/transactions/transfer',
      status: 429,
    });
    await expect(submitWithdrawal(env.ctx, withdrawal.id)).rejects.toBeInstanceOf(CircleApiError);
    expect(await getAccountBalance(env.db, userHeld(userId, 'USDC'))).toBe(usdc('1'));
    expect(await submitWithdrawal(env.ctx, withdrawal.id)).toMatchObject({ type: 'done' });
  });
});

describe('sweep и классификация входящих на treasury', () => {
  it('sweep переносит custody на treasury, а его входящая нога не считается house float', async () => {
    const { userId, wallet } = await newUserWithWallet('sweeper');
    await deposit(wallet.circle_wallet_id!, '20');
    const treasury = await requireTreasuryWallet(env.db);
    const houseBefore = await getAccountBalance(env.db, house('USDC'));
    const treasuryBefore = await getAccountBalance(env.db, custody(treasury.id, 'USDC'));

    expect(await runSweep(env.ctx, wallet.id, 'USDC')).toBe('SUBMITTED');
    // Повторный запуск при активном sweep ничего не создаёт.
    expect(await runSweep(env.ctx, wallet.id, 'USDC')).toBe('NOOP:sweep_in_flight');

    const sweep = await env.db.selectFrom('app.sweeps').selectAll().where('wallet_id', '=', wallet.id).executeTakeFirstOrThrow();
    const out = env.circle.setState(sweep.circle_transaction_id!, 'OUTBOUND', { state: 'COMPLETE', txHash: '0xsweephash' });
    expect(await applyCircleTransaction(env.ctx, out, 'webhook')).toBe('APPLIED:COMPLETED');

    // Входящая нога на treasury: тот же id (внутренний перевод Circle), источник — наш deposit-адрес.
    const leg = env.circle.addInbound(
      inbound(treasury.circle_wallet_id, '20', 'COMPLETE', {
        id: sweep.circle_transaction_id!,
        sourceAddress: wallet.address,
        txHash: '0xsweephash',
      }),
    );
    await applyCircleTransaction(env.ctx, leg, 'webhook');
    const row = await env.db
      .selectFrom('app.treasury_inbounds')
      .select('id')
      .where('circle_transaction_id', '=', leg.id)
      .executeTakeFirstOrThrow();
    expect(await classifyTreasuryInbound(env.ctx, row.id)).toEqual({ type: 'done', result: 'SWEEP' });

    expect(await getAccountBalance(env.db, custody(wallet.id, 'USDC'))).toBe(0n);
    expect(await getAccountBalance(env.db, custody(treasury.id, 'USDC'))).toBe(treasuryBefore + usdc('20'));
    expect(await getAccountBalance(env.db, house('USDC'))).toBe(houseBefore);
    // Баланс пользователя sweep не меняет — меняется только место хранения.
    expect(await getAccountBalance(env.db, userAvailable(userId, 'USDC'))).toBe(usdc('20'));
    await expectLedgerBalanced();
  });

  it('нога sweep без txHash и источника (другой id) не считается house float: сопоставление по refId', async () => {
    const { wallet } = await newUserWithWallet('sweep-refid');
    await deposit(wallet.circle_wallet_id!, '3');
    const treasury = await requireTreasuryWallet(env.db);
    const houseBefore = await getAccountBalance(env.db, house('USDC'));
    expect(await runSweep(env.ctx, wallet.id, 'USDC')).toBe('SUBMITTED');
    const sweep = await env.db.selectFrom('app.sweeps').selectAll().where('wallet_id', '=', wallet.id).executeTakeFirstOrThrow();
    const out = env.circle.setState(sweep.circle_transaction_id!, 'OUTBOUND', { state: 'COMPLETE' });
    await applyCircleTransaction(env.ctx, out, 'webhook');

    // Вебхук входящей ноги — без хэша и источника, но REST отдаёт refId нашего sweep.
    const leg = env.circle.addInbound(
      inbound(treasury.circle_wallet_id, '3', 'COMPLETE', { sourceAddress: null, refId: `sweep:${sweep.id}` }),
    );
    await applyCircleTransaction(env.ctx, { ...leg, refId: null }, 'webhook');
    const row = await env.db
      .selectFrom('app.treasury_inbounds')
      .select('id')
      .where('circle_transaction_id', '=', leg.id)
      .executeTakeFirstOrThrow();
    expect(await classifyTreasuryInbound(env.ctx, row.id)).toEqual({ type: 'done', result: 'SWEEP' });
    expect(await getAccountBalance(env.db, house('USDC'))).toBe(houseBefore);
    await expectLedgerBalanced();
  });

  it('поступление с нашего deposit-адреса без найденного sweep не попадает в house', async () => {
    const { wallet } = await newUserWithWallet('orphan');
    const treasury = await requireTreasuryWallet(env.db);
    const leg = inbound(treasury.circle_wallet_id, '1', 'COMPLETE', { sourceAddress: wallet.address });
    await applyCircleTransaction(env.ctx, leg, 'webhook');
    const row = await env.db
      .selectFrom('app.treasury_inbounds')
      .select('id')
      .where('circle_transaction_id', '=', leg.id)
      .executeTakeFirstOrThrow();
    expect(await classifyTreasuryInbound(env.ctx, row.id)).toMatchObject({ type: 'wait' });
  });

  it('мелочь ниже порога не сметается', async () => {
    const { wallet } = await newUserWithWallet('dust');
    await deposit(wallet.circle_wallet_id!, '0.5');
    expect(await runSweep(env.ctx, wallet.id, 'USDC')).toBe('NOOP:below_threshold');
  });
});

describe('переводы по UID (off-chain)', () => {
  const transfer = (senderId: string, recipientUid: string, amount: string, token = 'USDC', key: string = randomUUID()) =>
    createInternalTransfer(env.ctx, senderId, key, { token, amount, recipientUid });

  it('мгновенно переносит available, не трогает custody и виден обеим сторонам', async () => {
    const alice = await newUserWithWallet('alice');
    const bob = await newUserWithWallet('bob');
    await deposit(alice.wallet.circle_wallet_id!, '10');
    const treasury = await requireTreasuryWallet(env.db);
    const custodyBefore = await getAccountBalance(env.db, custody(alice.wallet.id, 'USDC'));
    const treasuryBefore = await getAccountBalance(env.db, custody(treasury.id, 'USDC'));
    const circleTransfersBefore = env.circle.transfers.size;

    const { transfer: t, replayed } = await transfer(alice.userId, bob.userId, '4');
    expect(replayed).toBe(false);
    expect(t.status).toBe('COMPLETED');

    expect(await getAccountBalance(env.db, userAvailable(alice.userId, 'USDC'))).toBe(usdc('6'));
    expect(await getAccountBalance(env.db, userAvailable(bob.userId, 'USDC'))).toBe(usdc('4'));
    // Деньги физически остались, где лежали: перевод меняет только «кому мы должны».
    expect(await getAccountBalance(env.db, custody(alice.wallet.id, 'USDC'))).toBe(custodyBefore);
    expect(await getAccountBalance(env.db, custody(treasury.id, 'USDC'))).toBe(treasuryBefore);
    const postings = await env.db
      .selectFrom('app.ledger_transactions')
      .select(['kind'])
      .where('reference_id', '=', t.id)
      .execute();
    expect(postings).toEqual([{ kind: 'INTERNAL_TRANSFER' }]);
    expect(env.circle.transfers.size).toBe(circleTransfersBefore);
    await expectLedgerBalanced();

    const [out] = (await listOperations(env.ctx, alice.userId, 10, undefined)).items;
    expect(out).toMatchObject({ id: t.id, type: 'TRANSFER_OUT', amount: '4', status: 'COMPLETED', counterpartyUid: bob.userId, txHash: null });
    const [incoming] = (await listOperations(env.ctx, bob.userId, 10, undefined)).items;
    expect(incoming).toMatchObject({ id: t.id, type: 'TRANSFER_IN', amount: '4', counterpartyUid: alice.userId });
  });

  it('получатель с ещё не созданным кошельком получает перевод: Circle не участвует', async () => {
    const sender = await newUserWithWallet('sender');
    await deposit(sender.wallet.circle_wallet_id!, '2');
    const recipient = await createUser(env.ctx, 'no-wallet-yet');
    expect(recipient.walletStatus).toBe('PENDING');

    await transfer(sender.userId, recipient.id, '2');
    expect(await getAccountBalance(env.db, userAvailable(recipient.id, 'USDC'))).toBe(usdc('2'));
    expect(await getAccountBalance(env.db, userAvailable(sender.userId, 'USDC'))).toBe(0n);
  });

  it('параллельные переводы не могут потратить больше баланса (double-spend)', async () => {
    const sender = await newUserWithWallet('transfer-race');
    const recipient = await newUserWithWallet('transfer-race-recipient');
    await deposit(sender.wallet.circle_wallet_id!, '10');

    const results = await Promise.allSettled(Array.from({ length: 6 }, () => transfer(sender.userId, recipient.userId, '3')));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(3);
    for (const r of rejected) expect((r.reason as AppError).code).toBe('INSUFFICIENT_FUNDS');

    expect(await getAccountBalance(env.db, userAvailable(sender.userId, 'USDC'))).toBe(usdc('1'));
    expect(await getAccountBalance(env.db, userAvailable(recipient.userId, 'USDC'))).toBe(usdc('9'));
    await expectLedgerBalanced();
  });

  it('встречные переводы A→B и B→A одновременно не ловят deadlock', async () => {
    const a = await newUserWithWallet('ping');
    const b = await newUserWithWallet('pong');
    await deposit(a.wallet.circle_wallet_id!, '10');
    await deposit(b.wallet.circle_wallet_id!, '10');

    // Без детерминированного порядка блокировок часть транзакций упала бы с 40P01 (deadlock detected).
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? transfer(a.userId, b.userId, '1') : transfer(b.userId, a.userId, '1'))),
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    expect(await getAccountBalance(env.db, userAvailable(a.userId, 'USDC'))).toBe(usdc('10'));
    expect(await getAccountBalance(env.db, userAvailable(b.userId, 'USDC'))).toBe(usdc('10'));

    // Счетов EURC ещё нет ни у кого: встречные транзакции создают одни и те же новые счета.
    // Ответ должен быть честным 422, а не deadlock на незакоммиченных вставках.
    const fresh = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? transfer(a.userId, b.userId, '1', 'EURC') : transfer(b.userId, a.userId, '1', 'EURC'))),
    );
    for (const r of fresh) {
      expect(r.status).toBe('rejected');
      expect(((r as PromiseRejectedResult).reason as AppError).code).toBe('INSUFFICIENT_FUNDS');
    }
    await expectLedgerBalanced();
  });

  it('Idempotency-Key: параллельный повтор возвращает тот же перевод, другое тело — 409', async () => {
    const sender = await newUserWithWallet('transfer-idem');
    const recipient = await newUserWithWallet('transfer-idem-recipient');
    await deposit(sender.wallet.circle_wallet_id!, '5');
    const key = randomUUID();

    // На весь баланс: проигравший гонку не должен получить 422 вместо того же перевода.
    const results = await Promise.all(Array.from({ length: 3 }, () => transfer(sender.userId, recipient.userId, '5', 'USDC', key)));
    expect(new Set(results.map((r) => r.transfer.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await getAccountBalance(env.db, userAvailable(recipient.userId, 'USDC'))).toBe(usdc('5'));

    // UID в другом регистре — тот же запрос, а не «другое тело».
    const replay = await transfer(sender.userId, recipient.userId.toUpperCase(), '5', 'USDC', key);
    expect(replay).toMatchObject({ replayed: true, transfer: { id: results[0]!.transfer.id } });
    await expect(transfer(sender.userId, recipient.userId, '4', 'USDC', key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('отклоняет перевод себе, неизвестному получателю, сверх баланса и некорректные запросы', async () => {
    const sender = await newUserWithWallet('transfer-validation');
    const recipient = await newUserWithWallet('Ivan Petrov');
    await deposit(sender.wallet.circle_wallet_id!, '1');

    await expect(transfer(sender.userId, sender.userId, '1')).rejects.toMatchObject({ code: 'SELF_TRANSFER' });
    await expect(transfer(sender.userId.toUpperCase(), sender.userId, '1')).rejects.toMatchObject({ code: 'SELF_TRANSFER' });
    await expect(transfer(sender.userId, randomUUID(), '1')).rejects.toMatchObject({ code: 'RECIPIENT_NOT_FOUND' });
    await expect(transfer(sender.userId, 'not-a-uid', '1')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(transfer(sender.userId, recipient.userId, '1.5')).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
      details: { available: '1' },
    });
    await expect(transfer(sender.userId, recipient.userId, '0')).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    await expect(transfer(sender.userId, recipient.userId, '0.0000001')).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    await expect(transfer(sender.userId, recipient.userId, '1', 'ETH')).rejects.toMatchObject({ code: 'TOKEN_NOT_SUPPORTED' });
    await expect(
      createInternalTransfer(env.ctx, sender.userId, undefined, { token: 'USDC', amount: '1', recipientUid: recipient.userId }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    await expect(transfer(randomUUID(), recipient.userId, '1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await getAccountBalance(env.db, userAvailable(sender.userId, 'USDC'))).toBe(usdc('1'));

    // Подтверждение получателя: маскированное имя, без балансов и адресов.
    expect(await getTransferRecipient(env.ctx, recipient.userId)).toEqual({ uid: recipient.userId, maskedName: 'Iv***' });
    await expect(getTransferRecipient(env.ctx, randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('полученное переводом выводится on-chain из treasury как обычно', async () => {
    await fundHouse('10');
    const sender = await newUserWithWallet('transfer-then-withdraw');
    const recipient = await newUserWithWallet('withdraws-received');
    await deposit(sender.wallet.circle_wallet_id!, '3');
    await transfer(sender.userId, recipient.userId, '3');

    const { withdrawal } = await createWithdrawal(env.ctx, recipient.userId, randomUUID(), {
      token: 'USDC',
      amount: '3',
      destinationAddress: EXTERNAL,
    });
    expect(await submitWithdrawal(env.ctx, withdrawal.id)).toEqual({ type: 'done', result: 'SUBMITTED' });
    const submitted = await env.db.selectFrom('app.withdrawals').selectAll().where('id', '=', withdrawal.id).executeTakeFirstOrThrow();
    const done = env.circle.setState(submitted.circle_transaction_id!, 'OUTBOUND', { state: 'COMPLETE', txHash: '0xdef' });
    expect(await applyCircleTransaction(env.ctx, done, 'webhook')).toBe('APPLIED:COMPLETED');

    expect(await getAccountBalance(env.db, userAvailable(recipient.userId, 'USDC'))).toBe(0n);
    expect(await getAccountBalance(env.db, userHeld(recipient.userId, 'USDC'))).toBe(0n);
    await expectLedgerBalanced();
  });
});
