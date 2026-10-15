'use client';

import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
import { queryKeys, useUser } from '@/lib/queries';
import { useEventStream } from '@/lib/use-event-stream';
import { ErrorMessage, Loading } from '../query-state';
import { BalancesCard } from './balances-card';
import { DepositCard } from './deposit-card';
import { OperationsHistory } from './operations-history';
import { WithdrawalForm } from './withdrawal-form';

function BackLink() {
  return (
    <Link href="/" className="text-sm text-blue-700 hover:underline">
      ← Все пользователи
    </Link>
  );
}

export function UserWalletPage({ userId }: { userId: string }) {
  const queryClient = useQueryClient();
  const user = useUser(userId);

  // Подключаемся, только когда пользователь точно существует (на 404 стрим не нужен).
  // invalidate / resync / ready одинаково означают «перечитай»: SSE несёт сигнал, а не данные.
  useEventStream(user.data ? `/users/${encodeURIComponent(userId)}/events` : null, () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.user(userId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.operations(userId) });
  });

  if (!user.data) {
    if (user.isError && user.error instanceof ApiError && user.error.status === 404) {
      return (
        <div className="flex flex-col gap-3">
          <BackLink />
          <h1 className="text-xl font-semibold">Пользователь не найден</h1>
          <p className="text-sm text-gray-600">
            Пользователя с id <span className="font-mono">{userId}</span> нет. Проверьте ссылку.
          </p>
        </div>
      );
    }
    if (user.isError) return <ErrorMessage error={user.error} onRetry={() => void user.refetch()} />;
    return <Loading />;
  }

  const details = user.data;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <BackLink />
        <h1 className="mt-1 text-2xl font-semibold">{details.name}</h1>
        <div className="font-mono text-xs text-gray-500">{details.id}</div>
      </div>

      {user.isError && <ErrorMessage error={user.error} onRetry={() => void user.refetch()} />}

      <div className="grid gap-6 lg:grid-cols-2">
        <DepositCard user={details} />
        <BalancesCard balances={details.balances} />
      </div>
      <WithdrawalForm user={details} />
      <OperationsHistory userId={userId} />
    </div>
  );
}
