/**
 * Денежная арифметика без float.
 *
 * Внутри системы суммы хранятся как целые числа в минимальных единицах токена (bigint),
 * наружу (API, Circle) отдаются десятичными строками в единицах токена ("12.5").
 * Парсинг намеренно строгий: лишние знаки после запятой — ошибка, а не округление,
 * иначе пользователь мог бы вывести не ту сумму, которую ввёл.
 */

export class MoneyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyFormatError';
  }
}

// Только неотрицательные десятичные числа без экспоненты, знака и ведущих нулей ("007" запрещено).
const DECIMAL_RE = /^(0|[1-9]\d*)(\.(\d+))?$/;

// Ограничение длины защищает от гигантских строк; 78 цифр = uint256.
const MAX_DIGITS = 78;

/** "12.5" (decimals=6) → 12500000n. Бросает MoneyFormatError при невалидном формате или лишней точности. */
export function parseUnits(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  const match = DECIMAL_RE.exec(trimmed);
  if (!match) {
    throw new MoneyFormatError(`Некорректная сумма: "${value}"`);
  }
  const whole = match[1] ?? '0';
  const fraction = match[3] ?? '';
  if (fraction.length > decimals) {
    throw new MoneyFormatError(`Слишком много знаков после запятой: максимум ${decimals}`);
  }
  if (whole.length + decimals > MAX_DIGITS) {
    throw new MoneyFormatError('Сумма слишком большая');
  }
  return BigInt(whole + fraction.padEnd(decimals, '0'));
}

/** 12500000n (decimals=6) → "12.5". Без хвостовых нулей и без экспоненты. */
export function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** Проверка формата без бросания исключения (для UI-валидации форм). */
export function isValidAmount(value: string, decimals: number): boolean {
  try {
    return parseUnits(value, decimals) > 0n;
  } catch {
    return false;
  }
}
