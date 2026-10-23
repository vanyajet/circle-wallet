/** Простая проверка формата для UX; полную валидацию (EIP-55, запрещённые адреса) делает бэкенд. */
export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** UID пользователя — его id (UUID). */
export const UID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EXPLORER_URL = 'https://sepolia.basescan.org';

/** 0x1234567890…abcd → 0x1234…abcd */
export function shortenHex(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('ru-RU');
}

export function txExplorerUrl(hash: string): string {
  return `${EXPLORER_URL}/tx/${hash}`;
}

export function addressExplorerUrl(address: string): string {
  return `${EXPLORER_URL}/address/${address}`;
}
