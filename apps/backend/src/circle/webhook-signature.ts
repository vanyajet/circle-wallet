import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { CircleGateway } from './gateway';

/**
 * Проверка подписи вебхуков Circle (notifications v2).
 *
 * Circle подписывает тело запроса ECDSA P-256 / SHA-256:
 *   X-Circle-Signature — base64 DER-подпись, X-Circle-Key-Id — id ключа.
 * Публичный ключ (base64 DER SPKI) берём из GET {CIRCLE_BASE_URL}/v2/notifications/publicKey/{keyId}
 * и кешируем по keyId: ключ для конкретного id статичен (так рекомендует документация).
 */
export class WebhookSignatureVerifier {
  private readonly keys = new Map<string, Promise<KeyObject>>();

  constructor(private readonly circle: Pick<CircleGateway, 'getNotificationPublicKey'>) {}

  /**
   * true — подпись валидна, false — невалидна.
   * Если ключ получить не удалось (Circle недоступен), бросает исключение: вызывающий код отвечает 5xx,
   * чтобы Circle повторил доставку, — потерять настоящее событие хуже, чем принять его позже.
   */
  async verify(rawBody: Buffer, signatureB64: string, keyId: string): Promise<boolean> {
    const key = await this.getKey(keyId);
    const signature = Buffer.from(signatureB64, 'base64');
    if (verify('sha256', rawBody, key, signature)) return true;

    // Подстраховка: в примерах Circle подпись считается от JSON.stringify(body). Если промежуточный прокси
    // переформатировал JSON, сырые байты отличаются, а семантически это то же сообщение, подписанное Circle.
    try {
      const canonical = Buffer.from(JSON.stringify(JSON.parse(rawBody.toString('utf8'))));
      return !canonical.equals(rawBody) && verify('sha256', canonical, key, signature);
    } catch {
      return false;
    }
  }

  private getKey(keyId: string): Promise<KeyObject> {
    let key = this.keys.get(keyId);
    if (!key) {
      key = this.circle.getNotificationPublicKey(keyId).then(({ publicKey }) =>
        createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }),
      );
      // Ошибку не кешируем: следующий вебхук попробует получить ключ заново.
      key.catch(() => this.keys.delete(keyId));
      this.keys.set(keyId, key);
    }
    return key;
  }
}
