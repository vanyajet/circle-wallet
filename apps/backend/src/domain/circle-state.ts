/**
 * State machine транзакций Circle (design-doc §7).
 *
 * Вебхуки приходят at-least-once и без гарантии порядка, CONFIRMED может прийти после COMPLETE,
 * а reconciliation может принести то же состояние ещё раз. Поэтому состояние меняется только «вперёд»
 * по рангу, а терминальное не меняется никогда. Эффекты в леджере вызываются только на переходе.
 */

const RANK: Record<string, number> = {
  INITIATED: 10,
  // Источники Circle расходятся в порядке CLEARED/QUEUED — держим их на одном уровне.
  CLEARED: 20,
  QUEUED: 20,
  // STUCK не терминальный: транзакцию можно ускорить (accelerate) и она вернётся в SENT.
  SENT: 30,
  STUCK: 30,
  CONFIRMED: 40,
  COMPLETE: 50,
  FAILED: 50,
  DENIED: 50,
  CANCELLED: 50,
};

const TERMINAL = new Set(['COMPLETE', 'FAILED', 'DENIED', 'CANCELLED']);
const FAILURE = new Set(['FAILED', 'DENIED', 'CANCELLED']);

export const isTerminalState = (state: string | null | undefined): boolean => !!state && TERMINAL.has(state);
export const isSuccessState = (state: string): boolean => state === 'COMPLETE';
export const isFailureState = (state: string): boolean => FAILURE.has(state);
export const isKnownState = (state: string): boolean => state in RANK;

/**
 * Нужно ли применить новое состояние поверх текущего.
 *  - неизвестное состояние (Circle добавил новое) — не применяем, а не падаем;
 *  - из терминального не выходим (опоздавший CONFIRMED после COMPLETE игнорируется);
 *  - внутри одного уровня разрешено «боковое» обновление (QUEUED ↔ CLEARED, SENT ↔ STUCK).
 */
export function shouldApplyState(current: string | null, next: string): boolean {
  const nextRank = RANK[next];
  if (nextRank === undefined) return false;
  if (current === null) return true;
  if (current === next || isTerminalState(current)) return false;
  return nextRank >= (RANK[current] ?? 0);
}
