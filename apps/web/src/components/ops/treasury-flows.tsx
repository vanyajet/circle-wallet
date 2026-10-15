import type { OpsSweepDto, OpsTreasuryInboundDto } from '@circle-wallet/shared';
import { formatDateTime } from '@/lib/format';
import { Badge, type BadgeTone } from '../badge';
import { Card } from '../card';
import { ShortAddress, TxHashLink } from '../hex';
import { EmptyRow, Table, Td } from '../table';

const SWEEP_STATUS: Record<OpsSweepDto['status'], { label: string; tone: BadgeTone }> = {
  PENDING: { label: 'Ожидает', tone: 'amber' },
  SUBMITTED: { label: 'В сети', tone: 'blue' },
  COMPLETED: { label: 'Завершён', tone: 'green' },
  FAILED: { label: 'Не выполнен', tone: 'red' },
};

const INBOUND_CLASSIFICATION: Record<OpsTreasuryInboundDto['classification'], { label: string; tone: BadgeTone }> =
  {
    PENDING: { label: 'Классифицируется', tone: 'amber' },
    SWEEP: { label: 'Sweep', tone: 'green' },
    HOUSE_FUNDING: { label: 'House float', tone: 'green' },
    UNCLASSIFIED: { label: 'Требует разбора', tone: 'red' },
    FAILED: { label: 'Не выполнен', tone: 'red' },
  };

const SWEEP_COLUMNS = ['Deposit-кошелёк', 'Сумма', 'Статус', 'Circle', 'Tx', 'Создан', 'Завершён'];
const INBOUND_COLUMNS = ['Сумма', 'Классификация', 'Источник', 'Circle', 'Tx', 'Создано'];

export function RecentSweepsTable({ sweeps }: { sweeps: OpsSweepDto[] }) {
  return (
    <Card title="Последние sweep">
      <Table head={SWEEP_COLUMNS}>
        {sweeps.length === 0 && <EmptyRow colSpan={SWEEP_COLUMNS.length}>Sweep пока не было</EmptyRow>}
        {sweeps.map((sweep) => {
          const status = SWEEP_STATUS[sweep.status];
          return (
            <tr key={sweep.id}>
              <Td>
                <ShortAddress address={sweep.walletAddress} copy={false} />
              </Td>
              <Td className="whitespace-nowrap tabular-nums">
                {sweep.amount} {sweep.token}
              </Td>
              <Td>
                <Badge tone={status?.tone ?? 'gray'}>{status?.label ?? sweep.status}</Badge>
              </Td>
              <Td className="text-xs text-gray-500">{sweep.circleState ?? '—'}</Td>
              <Td>
                <TxHashLink hash={sweep.txHash} />
              </Td>
              <Td className="whitespace-nowrap text-gray-600">{formatDateTime(sweep.createdAt)}</Td>
              <Td className="whitespace-nowrap text-gray-600">{formatDateTime(sweep.completedAt)}</Td>
            </tr>
          );
        })}
      </Table>
    </Card>
  );
}

export function RecentTreasuryInboundsTable({ inbounds }: { inbounds: OpsTreasuryInboundDto[] }) {
  return (
    <Card title="Последние поступления на treasury">
      <Table head={INBOUND_COLUMNS}>
        {inbounds.length === 0 && <EmptyRow colSpan={INBOUND_COLUMNS.length}>Поступлений пока не было</EmptyRow>}
        {inbounds.map((inbound) => {
          const classification = INBOUND_CLASSIFICATION[inbound.classification];
          return (
            <tr key={inbound.id}>
              <Td className="whitespace-nowrap tabular-nums">
                {inbound.amount} {inbound.token}
              </Td>
              <Td>
                <Badge tone={classification?.tone ?? 'gray'}>
                  {classification?.label ?? inbound.classification}
                </Badge>
              </Td>
              <Td>
                <ShortAddress address={inbound.sourceAddress} copy={false} />
              </Td>
              <Td className="text-xs text-gray-500">{inbound.circleState}</Td>
              <Td>
                <TxHashLink hash={inbound.txHash} />
              </Td>
              <Td className="whitespace-nowrap text-gray-600">{formatDateTime(inbound.createdAt)}</Td>
            </tr>
          );
        })}
      </Table>
    </Card>
  );
}
