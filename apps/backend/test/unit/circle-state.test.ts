import { describe, expect, it } from 'vitest';
import { shouldApplyState } from '../../src/domain/circle-state';

describe('shouldApplyState — монотонная state machine транзакций Circle', () => {
  it('движется только вперёд', () => {
    expect(shouldApplyState(null, 'INITIATED')).toBe(true);
    expect(shouldApplyState('INITIATED', 'SENT')).toBe(true);
    expect(shouldApplyState('SENT', 'CONFIRMED')).toBe(true);
    expect(shouldApplyState('CONFIRMED', 'COMPLETE')).toBe(true);
    expect(shouldApplyState('CONFIRMED', 'SENT')).toBe(false);
  });

  it('терминальное состояние не меняется (опоздавший CONFIRMED, повторный COMPLETE, COMPLETE после FAILED)', () => {
    expect(shouldApplyState('COMPLETE', 'CONFIRMED')).toBe(false);
    expect(shouldApplyState('COMPLETE', 'COMPLETE')).toBe(false);
    expect(shouldApplyState('FAILED', 'COMPLETE')).toBe(false);
    expect(shouldApplyState('CANCELLED', 'FAILED')).toBe(false);
  });

  it('разрешает «боковые» переходы внутри уровня: CLEARED↔QUEUED, SENT↔STUCK', () => {
    expect(shouldApplyState('QUEUED', 'CLEARED')).toBe(true);
    expect(shouldApplyState('CLEARED', 'QUEUED')).toBe(true);
    expect(shouldApplyState('SENT', 'STUCK')).toBe(true);
    expect(shouldApplyState('STUCK', 'SENT')).toBe(true);
  });

  it('из CONFIRMED можно в FAILED (reorg)', () => {
    expect(shouldApplyState('CONFIRMED', 'FAILED')).toBe(true);
  });

  it('игнорирует неизвестные состояния вместо падения', () => {
    expect(shouldApplyState('SENT', 'SOMETHING_NEW')).toBe(false);
    expect(shouldApplyState(null, 'WAITING')).toBe(false);
  });
});
