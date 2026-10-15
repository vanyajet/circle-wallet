/**
 * Unit-тесты клиента Circle с подменённым fetch: проверяем то, что нельзя увидеть без сети, —
 * формат запросов, свежий ciphertext на каждый запрос, классификацию ошибок, пагинацию от base URL,
 * проверку подписи вебхуков.
 */
import { constants, generateKeyPairSync, privateDecrypt, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CircleClient, parseNextPageAfter } from '../../src/circle/client';
import { CircleApiError, classifyCircleError } from '../../src/circle/errors';
import { WebhookSignatureVerifier } from '../../src/circle/webhook-signature';
import { createLogger } from '../../src/lib/logger';

const ENTITY_SECRET = 'ab'.repeat(32);
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const RSA_PUBLIC_PEM = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString();

interface Call {
  url: URL;
  init: RequestInit;
  body: Record<string, unknown> | undefined;
}

function makeClient(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const call: Call = {
      url: new URL(String(input)),
      init,
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    };
    calls.push(call);
    if (call.url.pathname === '/v1/w3s/config/entity/publicKey') {
      return Response.json({ data: { publicKey: RSA_PUBLIC_PEM } });
    }
    return respond(call);
  }) as typeof fetch;
  const client = new CircleClient({
    baseUrl: 'https://mock.circle.test/', // завершающий "/" должен обрезаться
    apiKey: 'TEST_API_KEY:id:secret',
    entitySecret: ENTITY_SECRET,
    timeoutMs: 1_000,
    logger: createLogger('test'),
    fetchImpl,
  });
  return { client, calls };
}

const transferInput = {
  idempotencyKey: '11111111-1111-4111-8111-111111111111',
  walletId: 'w1',
  tokenId: 't1',
  destinationAddress: '0xabc',
  amount: '1.5',
  refId: 'withdrawal:1',
};

describe('CircleClient', () => {
  it('строит URL от base URL, передаёт API key, idempotencyKey и свежий ciphertext на каждый запрос', async () => {
    const { client, calls } = makeClient(() => Response.json({ data: { id: 'tx1', state: 'INITIATED' } }, { status: 201 }));
    await client.createTransfer(transferInput);
    await client.createTransfer(transferInput);

    const transfers = calls.filter((c) => c.url.pathname === '/v1/w3s/developer/transactions/transfer');
    expect(transfers).toHaveLength(2);
    expect(transfers[0]!.url.origin).toBe('https://mock.circle.test');
    expect((transfers[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer TEST_API_KEY:id:secret');
    expect(transfers[0]!.body).toMatchObject({
      idempotencyKey: transferInput.idempotencyKey,
      walletId: 'w1',
      tokenId: 't1',
      amounts: ['1.5'],
      feeLevel: 'MEDIUM',
      refId: 'withdrawal:1',
    });

    const c1 = transfers[0]!.body!.entitySecretCiphertext as string;
    const c2 = transfers[1]!.body!.entitySecretCiphertext as string;
    expect(c1).not.toBe(c2); // Circle запрещает повтор ciphertext (156004)
    for (const ct of [c1, c2]) {
      const decrypted = privateDecrypt(
        { key: rsa.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from(ct, 'base64'),
      );
      expect(decrypted.toString('hex')).toBe(ENTITY_SECRET);
    }
    // Публичный ключ entity запрашивается один раз и кешируется.
    expect(calls.filter((c) => c.url.pathname === '/v1/w3s/config/entity/publicKey')).toHaveLength(1);
  });

  it('createWallet запрашивает SCA явно (по умолчанию Circle создаёт EOA)', async () => {
    const { client, calls } = makeClient(() =>
      Response.json({ data: { wallets: [{ id: 'w', address: '0xA', blockchain: 'BASE-SEPOLIA', state: 'LIVE' }] } }, { status: 201 }),
    );
    await client.createWallet({ idempotencyKey: 'k', walletSetId: 's', blockchain: 'BASE-SEPOLIA', name: 'n', refId: 'u' });
    const body = calls.find((c) => c.url.pathname === '/v1/w3s/developer/wallets')!.body!;
    expect(body).toMatchObject({ accountType: 'SCA', blockchains: ['BASE-SEPOLIA'], idempotencyKey: 'k', metadata: [{ refId: 'u' }] });
  });

  it('getTransaction передаёт txType и нормализует пустые строки в null', async () => {
    const { client, calls } = makeClient(() =>
      Response.json({
        data: {
          transaction: {
            id: 'tx',
            state: 'COMPLETE',
            blockchain: 'BASE-SEPOLIA',
            transactionType: 'INBOUND',
            walletId: 'w',
            tokenId: 't',
            amounts: ['20'],
            txHash: '0xH',
            sourceAddress: '0xAbC',
            errorReason: '',
            createDate: '2026-10-15T00:00:00Z',
            updateDate: '2026-10-15T00:00:00Z',
          },
        },
      }),
    );
    const tx = await client.getTransaction('tx', 'INBOUND');
    expect(calls[0]!.url.searchParams.get('txType')).toBe('INBOUND');
    expect(tx).toMatchObject({ amount: '20', errorReason: null, sourceAddress: '0xabc', refId: null });
  });

  it('классифицирует ошибки по смыслу «могли ли деньги уйти»', async () => {
    const reject = (status: number, body: unknown) => makeClient(() => Response.json(body, { status })).client;
    const kindOf = async (client: CircleClient) => {
      try {
        await client.createTransfer(transferInput);
        throw new Error('expected failure');
      } catch (e) {
        return (e as CircleApiError).kind;
      }
    };
    expect(await kindOf(reject(400, { code: 2, message: 'API parameter invalid' }))).toBe('DEFINITIVE');
    expect(await kindOf(reject(429, { code: 429, message: 'Too many' }))).toBe('RETRYABLE');
    expect(await kindOf(reject(400, { code: 155264, message: 'queue full' }))).toBe('RETRYABLE');
    expect(await kindOf(reject(403, { code: 156020, message: 'Please use a new idempotency key.' }))).toBe('UNKNOWN_OUTCOME');
    expect(await kindOf(reject(503, { message: 'unavailable' }))).toBe('UNKNOWN_OUTCOME');
    expect(await kindOf(reject(401, { code: 401, message: 'Invalid credentials.' }))).toBe('CONFIG');
    // 2xx, но не та форма ответа — перевод мог быть создан.
    expect(await kindOf(reject(201, { unexpected: true }))).toBe('UNKNOWN_OUTCOME');
    // Нет ответа вообще (сеть/таймаут).
    expect(classifyCircleError(new CircleApiError('timeout', { method: 'POST', path: '/x' }))).toBe('UNKNOWN_OUTCOME');
  });

  it('пагинация: берёт курсор из Link, но не использует абсолютный URL Circle', () => {
    const link = '<https://api.circle.com/v1/w3s/transactions?pageAfter=abc-123&pageSize=50>; rel="next"';
    expect(parseNextPageAfter(link)).toBe('abc-123');
    expect(parseNextPageAfter('<https://api.circle.com/x?pageBefore=1>; rel="prev"')).toBeNull();
    expect(parseNextPageAfter(null)).toBeNull();
  });
});

describe('WebhookSignatureVerifier', () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyB64 = ec.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const verifier = new WebhookSignatureVerifier({
    getNotificationPublicKey: async (id) => ({ id, algorithm: 'ECDSA_SHA_256', publicKey: publicKeyB64 }),
  });
  const body = Buffer.from(JSON.stringify({ notificationId: 'n1', notificationType: 'transactions.inbound' }));
  const signature = sign('sha256', body, ec.privateKey).toString('base64');

  it('принимает корректную подпись сырого тела', async () => {
    expect(await verifier.verify(body, signature, 'key-1')).toBe(true);
  });

  it('отклоняет изменённое тело и чужую подпись', async () => {
    const tampered = Buffer.from(body.toString().replace('n1', 'n2'));
    expect(await verifier.verify(tampered, signature, 'key-1')).toBe(false);
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    expect(await verifier.verify(body, sign('sha256', body, other.privateKey).toString('base64'), 'key-1')).toBe(false);
  });

  it('пробрасывает ошибку получения ключа (вызывающий код ответит 503, Circle повторит)', async () => {
    const failing = new WebhookSignatureVerifier({
      getNotificationPublicKey: async () => {
        throw new Error('Circle unavailable');
      },
    });
    await expect(failing.verify(body, signature, 'key-x')).rejects.toThrow('Circle unavailable');
  });
});
