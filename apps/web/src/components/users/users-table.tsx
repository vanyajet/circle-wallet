import Link from 'next/link';
import type { UserSummaryDto } from '@circle-wallet/shared';
import { formatDateTime } from '@/lib/format';
import { ShortAddress } from '../hex';
import { WalletStatusBadge } from '../status-badges';
import { EmptyRow, Table, Td } from '../table';

export function UsersTable({ users }: { users: UserSummaryDto[] }) {
  return (
    <Table head={['Имя', 'Deposit-адрес', 'Кошелёк', 'Создан']}>
      {users.length === 0 && <EmptyRow colSpan={4}>Пользователей пока нет</EmptyRow>}
      {users.map((user) => (
        <tr key={user.id}>
          <Td>
            <Link href={`/users/${user.id}`} className="font-medium text-blue-700 hover:underline">
              {user.name}
            </Link>
          </Td>
          <Td>
            {user.walletStatus === 'PENDING' ? (
              <span className="text-gray-500">создаётся…</span>
            ) : (
              <ShortAddress address={user.depositAddress} />
            )}
          </Td>
          <Td>
            <WalletStatusBadge status={user.walletStatus} />
          </Td>
          <Td className="whitespace-nowrap text-gray-600">{formatDateTime(user.createdAt)}</Td>
        </tr>
      ))}
    </Table>
  );
}
