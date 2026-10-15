import type { ReactNode } from 'react';

/** Цвета статусов: в процессе — amber/blue, успех — green, ошибка — red. */
export type BadgeTone = 'gray' | 'amber' | 'blue' | 'green' | 'red';

const TONE_CLASSES: Record<BadgeTone, string> = {
  gray: 'bg-gray-100 text-gray-700 ring-gray-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  blue: 'bg-blue-50 text-blue-800 ring-blue-200',
  green: 'bg-green-50 text-green-800 ring-green-200',
  red: 'bg-red-50 text-red-800 ring-red-200',
};

export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}
