import type { OpsBalanceCheckDto } from '@circle-wallet/shared';
import { formatDateTime } from '@/lib/format';
import { Card } from '../card';
import { ShortAddress } from '../hex';
import { EmptyRow, Table, Td } from '../table';

const WALLET_KIND_LABELS: Record<OpsBalanceCheckDto['walletKind'], string> = {
  DEPOSIT: 'Deposit',
  TREASURY: 'Treasury',
};

const COLUMNS = ['Кошелёк', 'Адрес', 'Токен', 'По леджеру', 'On-chain', 'Разница', 'Проверено'];

export function BalanceChecksTable({ checks }: { checks: OpsBalanceCheckDto[] }) {
  return (
    <Card title="Сверка с блокчейном">
      <Table head={COLUMNS}>
        {checks.length === 0 && <EmptyRow colSpan={COLUMNS.length}>Сверок пока не было</EmptyRow>}
        {checks.map((check) => {
          // difference = on-chain − ledger; отрицательная — на кошельке меньше, чем мы считаем (тревога).
          const negative = check.difference.trim().startsWith('-');
          return (
            <tr key={`${check.walletId}:${check.token}`} className={negative ? 'bg-red-50' : undefined}>
              <Td>{WALLET_KIND_LABELS[check.walletKind]}</Td>
              <Td>
                <ShortAddress address={check.address} copy={false} />
              </Td>
              <Td>{check.token}</Td>
              <Td className="tabular-nums">{check.ledgerCustody}</Td>
              <Td className="tabular-nums">{check.onChain}</Td>
              <Td className={`tabular-nums ${negative ? 'font-semibold text-red-700' : ''}`}>{check.difference}</Td>
              <Td className="whitespace-nowrap text-gray-600">{formatDateTime(check.checkedAt)}</Td>
            </tr>
          );
        })}
      </Table>
    </Card>
  );
}
