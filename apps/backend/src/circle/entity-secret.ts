import { constants, createPublicKey, publicEncrypt, type KeyObject } from 'node:crypto';

/**
 * Entity secret ciphertext — доказательство для Circle, что мутирующий запрос отдаёт владелец кошельков.
 *
 * ciphertext = base64( RSA-OAEP(SHA-256, MGF1-SHA-256)( 32 байта entity secret ) ) на публичном ключе
 * из GET /v1/w3s/config/entity/publicKey. OAEP рандомизирован, поэтому каждый вызов даёт новый
 * ciphertext — а Circle как раз требует уникальный ciphertext на каждый запрос (повтор → ошибка 156004).
 */
export function encryptEntitySecret(publicKey: KeyObject, entitySecretHex: string): string {
  return publicEncrypt(
    { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(entitySecretHex, 'hex'),
  ).toString('base64');
}

/**
 * Circle отдаёт ключ в PEM, но заголовок PEM у разных версий бывал разным ("PUBLIC KEY" / "RSA PUBLIC KEY"),
 * а внутри — SPKI DER. Поэтому, как и официальный SDK, снимаем заголовки и разбираем DER сами:
 * сначала как SPKI, при неудаче — как PKCS#1.
 */
export function parseEntityPublicKey(pem: string): KeyObject {
  const der = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
  try {
    return createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    return createPublicKey({ key: der, format: 'der', type: 'pkcs1' });
  }
}
