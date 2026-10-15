import type {
  DepositStatus,
  OperationStatus,
  OperationType,
  WalletStatus,
  WithdrawalStatus,
} from '@circle-wallet/shared';
import { Badge, type BadgeTone } from './badge';

export function WalletStatusBadge({ status }: { status: WalletStatus }) {
  return status === 'ACTIVE' ? <Badge tone="green">Активен</Badge> : <Badge tone="amber">Создаётся</Badge>;
}

const DEPOSIT_LABELS: Record<DepositStatus, string> = {
  PENDING: 'Ожидает финализации',
  COMPLETED: 'Зачислен',
  FAILED: 'Не выполнен',
};

const WITHDRAWAL_LABELS: Record<WithdrawalStatus, string> = {
  PENDING: 'В очереди',
  SUBMITTING: 'Отправляется',
  SUBMITTED: 'В сети',
  COMPLETED: 'Выполнен',
  FAILED: 'Не выполнен',
};

const OPERATION_TONES: Record<OperationStatus, BadgeTone> = {
  PENDING: 'amber',
  SUBMITTING: 'blue',
  SUBMITTED: 'blue',
  COMPLETED: 'green',
  FAILED: 'red',
};

export function operationStatusLabel(type: OperationType, status: OperationStatus): string {
  const labels: Partial<Record<OperationStatus, string>> = type === 'DEPOSIT' ? DEPOSIT_LABELS : WITHDRAWAL_LABELS;
  return labels[status] ?? status;
}

export function OperationStatusBadge({ type, status }: { type: OperationType; status: OperationStatus }) {
  return <Badge tone={OPERATION_TONES[status] ?? 'gray'}>{operationStatusLabel(type, status)}</Badge>;
}
