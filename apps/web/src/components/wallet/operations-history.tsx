'use client';

import { useMemo } from 'react';
import type { OperationDto } from '@circle-wallet/shared';
import { formatDateTime } from '@/lib/format';
import { useOperations } from '@/lib/queries';
import { Card } from '../card';
import { ShortAddress, TxHashLink } from '../hex';
import { ErrorMessage, Loading } from '../query-state';
import { OperationStatusBadge } from '../status-badges';
import { EmptyRow, Table, Td } from '../table';

const TYPE_LABELS: Record<OperationDto['type'], string> = {
  DEPOSIT: 'Пополнение',
  WITHDRAWAL: 'Вывод',
};

const COLUMNS = ['Тип', 'Сумма', 'Статус', 'Circle', 'Контрагент', 'Tx', 'Создана', 'Ошибка'];

function OperationRow({ operation }: { operation: OperationDto }) {
  const awaitingLiquidity =
    operation.type === 'WITHDRAWAL' && operation.status === 'PENDING' && operation.awaitingLiquidity;
  return (
    <tr>
      <Td className="whitespace-nowrap">{TYPE_LABELS[operation.type]}</Td>
      <Td className="whitespace-nowrap tabular-nums">
        {operation.amount} {operation.token}
      </Td>
      <Td>
        <OperationStatusBadge type={operation.type} status={operation.status} />
        {awaitingLiquidity && (
          <div className="mt-1 whitespace-nowrap text-xs text-amber-700">ждёт ликвидности treasury</div>
        )}
      </Td>
      <Td className="text-xs text-gray-500">{operation.circleState ?? '—'}</Td>
      <Td>
        <ShortAddress address={operation.counterpartyAddress} copy={false} />
      </Td>
      <Td>
        <TxHashLink hash={operation.txHash} />
      </Td>
      <Td className="whitespace-nowrap text-gray-600">{formatDateTime(operation.createdAt)}</Td>
      <Td className="max-w-xs">
        {operation.errorReason || operation.errorDetails ? (
          <>
            {operation.errorReason && <div className="text-red-700">{operation.errorReason}</div>}
            {operation.errorDetails && (
              <div className="break-words text-xs text-gray-500">{operation.errorDetails}</div>
            )}
          </>
        ) : (
          <span className="text-gray-400">—</span>
        )}
      </Td>
    </tr>
  );
}

export function OperationsHistory({ userId }: { userId: string }) {
  const operations = useOperations(userId);

  const items = useMemo(() => {
    // Курсор непрозрачный: на случай, если новые операции сдвинут страницы, убираем дубли по id.
    const seen = new Set<string>();
    const result: OperationDto[] = [];
    for (const page of operations.data?.pages ?? []) {
      for (const item of page.items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        result.push(item);
      }
    }
    return result;
  }, [operations.data]);

  return (
    <Card title="История операций">
      {operations.isPending ? (
        <Loading />
      ) : operations.isError && !operations.data ? (
        <ErrorMessage error={operations.error} onRetry={() => void operations.refetch()} />
      ) : (
        <>
          <Table head={COLUMNS}>
            {items.length === 0 && <EmptyRow colSpan={COLUMNS.length}>Операций пока нет</EmptyRow>}
            {items.map((operation) => (
              <OperationRow key={operation.id} operation={operation} />
            ))}
          </Table>
          {operations.isFetchNextPageError && (
            <div className="mt-3">
              <ErrorMessage error={operations.error} />
            </div>
          )}
          {operations.hasNextPage && (
            <div className="mt-3 text-center">
              <button
                type="button"
                onClick={() => void operations.fetchNextPage()}
                disabled={operations.isFetchingNextPage}
                className="rounded border border-gray-300 px-4 py-2 text-sm hover:bg-gray-100 disabled:opacity-50"
              >
                {operations.isFetchingNextPage ? 'Загрузка…' : 'Загрузить ещё'}
              </button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
