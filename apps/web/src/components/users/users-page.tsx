'use client';

import { useQueryClient } from '@tanstack/react-query';
import { queryKeys, useUsers } from '@/lib/queries';
import { useEventStream } from '@/lib/use-event-stream';
import { Card } from '../card';
import { ErrorMessage, Loading } from '../query-state';
import { CreateUserForm } from './create-user-form';
import { UsersTable } from './users-table';

export function UsersPage() {
  const queryClient = useQueryClient();
  const users = useUsers();

  // Любое событие может менять список (кошелёк стал ACTIVE, новый пользователь) — просто перечитываем.
  useEventStream('/events', () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.users });
  });

  return (
    <div className="flex flex-col gap-6">
      <Card title="Новый пользователь">
        <CreateUserForm />
      </Card>
      <Card title="Пользователи">
        {users.isPending ? (
          <Loading />
        ) : users.isError ? (
          <ErrorMessage error={users.error} onRetry={() => void users.refetch()} />
        ) : (
          <UsersTable users={users.data.items} />
        )}
      </Card>
    </div>
  );
}
