import type { OpsTokenOverviewDto } from '@circle-wallet/shared';
import { Card } from '../card';
import { Table, Td } from '../table';

type AmountKey = Exclude<keyof OpsTokenOverviewDto, 'token' | 'decimals' | 'ledgerBalanced'>;

// Строки — показатели, колонки — токены: так помещаются пояснения к каждому показателю.
const METRICS: { key: AmountKey; label: string; hint: string }[] = [
  { key: 'custodyTotal', label: 'Под управлением', hint: 'Σ CUSTODY по всем кошелькам сервиса' },
  { key: 'treasuryCustody', label: 'На treasury', hint: 'CUSTODY treasury-кошелька' },
  { key: 'inFlightWithdrawals', label: 'Выводы в пути', hint: 'SUBMITTING / SUBMITTED — уже обещанная часть treasury' },
  { key: 'treasuryLiquidity', label: 'Ликвидность для выводов', hint: 'treasury − выводы в пути' },
  { key: 'unsweptDeposits', label: 'Не сметено в treasury', hint: 'CUSTODY deposit-кошельков до завершения sweep' },
  { key: 'usersAvailable', label: 'Пользователи: доступно', hint: 'Σ USER_AVAILABLE' },
  { key: 'usersHeld', label: 'Пользователи: в резерве', hint: 'Σ USER_HELD — под выводы в процессе' },
  { key: 'house', label: 'House', hint: 'Σ HOUSE — собственные средства сервиса (house float)' },
];

export function TokenOverviewTable({ tokens }: { tokens: OpsTokenOverviewDto[] }) {
  return (
    <Card title="Балансы по токенам">
      {tokens.length === 0 ? (
        <p className="text-sm text-gray-500">Нет данных по токенам</p>
      ) : (
        <Table head={['Показатель', ...tokens.map((t) => t.token)]}>
          {METRICS.map((metric) => (
            <tr key={metric.key}>
              <Td>
                <div className="font-medium">{metric.label}</div>
                <div className="text-xs text-gray-500">{metric.hint}</div>
              </Td>
              {tokens.map((t) => (
                <Td key={t.token} className="whitespace-nowrap tabular-nums">
                  {t[metric.key]}
                </Td>
              ))}
            </tr>
          ))}
          <tr>
            <Td>
              <div className="font-medium">Тождество леджера</div>
            </Td>
            {tokens.map((t) => (
              <Td key={t.token}>
                {t.ledgerBalanced ? (
                  <span className="font-semibold text-green-700">✓ сходится</span>
                ) : (
                  <span className="font-semibold text-red-700">✗ не сходится</span>
                )}
              </Td>
            ))}
          </tr>
        </Table>
      )}
      <p className="mt-3 text-xs text-gray-600">
        Тождество леджера: Σ CUSTODY = Σ USER_AVAILABLE + Σ USER_HELD + Σ HOUSE — всё, что лежит на кошельках
        сервиса, принадлежит либо пользователям, либо самому сервису.
      </p>
    </Card>
  );
}
