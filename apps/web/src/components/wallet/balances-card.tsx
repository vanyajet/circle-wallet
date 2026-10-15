import type { BalanceDto } from '@circle-wallet/shared';
import { Card } from '../card';

/** Суммы — десятичные строки от бэкенда, показываем как есть (без float). */
export function BalancesCard({ balances }: { balances: BalanceDto[] }) {
  return (
    <Card title="Баланс">
      {balances.length === 0 ? (
        <p className="text-sm text-gray-500">Балансов пока нет</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {balances.map((balance) => (
            <div key={balance.token} className="rounded border border-gray-200 p-3">
              <div className="text-xs text-gray-500">Доступно</div>
              <div className="text-xl font-semibold tabular-nums">
                {balance.available} <span className="text-sm font-normal text-gray-500">{balance.token}</span>
              </div>
              <div className="mt-1 text-xs text-gray-600">
                в резерве под выводы: <span className="tabular-nums">{balance.held}</span> {balance.token}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
