import { useMemo, useRef } from 'react';

function randomUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // randomUUID есть только в secure context (https / localhost) — иначе собираем UUID v4 вручную.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface IdempotencyKeyStore {
  /** Ключ для отправки с данными `fingerprint`: тот же, что в прошлый раз, если данные не менялись. */
  keyFor(fingerprint: string): string;
  /** Забыть ключ: следующая отправка получит новый. */
  reset(): void;
}

/**
 * Idempotency-Key для формы. Ключ привязан к содержимому формы:
 * - повтор тех же данных после неизвестного исхода (сеть/5xx) идёт с тем же ключом — если первый запрос
 *   на самом деле дошёл, бэкенд вернёт тот же вывод, а не создаст второй;
 * - изменение любого поля даёт новый ключ (тот же ключ с другим телом бэкенд отклонит 409);
 * - после успеха или однозначного отказа (4xx) вызывающий код делает reset().
 */
export function useIdempotencyKey(): IdempotencyKeyStore {
  const slot = useRef<{ fingerprint: string; key: string } | null>(null);
  return useMemo(
    () => ({
      keyFor(fingerprint) {
        if (slot.current?.fingerprint !== fingerprint) {
          slot.current = { fingerprint, key: randomUuid() };
        }
        return slot.current.key;
      },
      reset() {
        slot.current = null;
      },
    }),
    [],
  );
}
