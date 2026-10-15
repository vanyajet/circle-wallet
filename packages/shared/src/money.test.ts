import { describe, expect, it } from 'vitest';
import { formatUnits, MoneyFormatError, parseUnits } from './money';

describe('parseUnits', () => {
  it('переводит десятичную строку в минимальные единицы', () => {
    expect(parseUnits('12.5', 6)).toBe(12_500_000n);
    expect(parseUnits('0.000001', 6)).toBe(1n);
    expect(parseUnits('20', 6)).toBe(20_000_000n);
    expect(parseUnits(' 1.0 ', 6)).toBe(1_000_000n);
  });

  it('работает с 18 decimals без потери точности', () => {
    expect(parseUnits('123456789.123456789123456789', 18)).toBe(123456789123456789123456789n);
  });

  it('отвергает лишнюю точность вместо округления', () => {
    expect(() => parseUnits('0.0000001', 6)).toThrow(MoneyFormatError);
  });

  it.each(['', '-1', '1e6', '01', '.5', '5.', '1,5', 'abc', '0x10', 'Infinity', 'NaN'])(
    'отвергает некорректный формат %j',
    (value) => {
      expect(() => parseUnits(value, 6)).toThrow(MoneyFormatError);
    },
  );
});

describe('formatUnits', () => {
  it('форматирует без хвостовых нулей', () => {
    expect(formatUnits(12_500_000n, 6)).toBe('12.5');
    expect(formatUnits(20_000_000n, 6)).toBe('20');
    expect(formatUnits(1n, 6)).toBe('0.000001');
    expect(formatUnits(0n, 6)).toBe('0');
  });

  it('round-trip parse → format', () => {
    for (const v of ['0', '1', '0.1', '123.456789', '999999999999.000001']) {
      expect(formatUnits(parseUnits(v, 6), 6)).toBe(v);
    }
  });
});
