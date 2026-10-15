import type { ReactNode } from 'react';

/** Минимальные обёртки таблицы с единым стилем; горизонтальный скролл на узких экранах. */
export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        <thead>
          <tr>
            {head.map((cell, index) => (
              <th
                key={index}
                className="whitespace-nowrap px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <td className={`px-3 py-2 align-top ${className}`}>{children}</td>;
}

/** Строка-заглушка для пустой таблицы. */
export function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-4 text-center text-sm text-gray-500">
        {children}
      </td>
    </tr>
  );
}
