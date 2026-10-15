import type { UserDetailsDto } from '@circle-wallet/shared';
import { addressExplorerUrl } from '@/lib/format';
import { Card } from '../card';
import { CopyButton } from '../copy-button';

const FAUCET_URL = 'https://faucet.circle.com';

export function DepositCard({ user }: { user: UserDetailsDto }) {
  const address = user.walletStatus === 'ACTIVE' ? user.depositAddress : null;

  return (
    <Card title="Пополнение">
      {address ? (
        <>
          <div className="mb-1 text-xs text-gray-500">Deposit-адрес ({user.blockchain})</div>
          <div className="flex flex-wrap items-center gap-2">
            <code className="break-all font-mono text-sm">{address}</code>
            <CopyButton value={address} />
            <a
              href={addressExplorerUrl(address)}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-blue-700 hover:underline"
            >
              Basescan
            </a>
          </div>
          <p className="mt-3 text-sm text-gray-600">
            Пополните через{' '}
            <a href={FAUCET_URL} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline">
              {FAUCET_URL}
            </a>{' '}
            — сеть Base Sepolia, токены USDC или EURC. Пополнение появится в истории; баланс обновится после
            финализации (COMPLETE).
          </p>
        </>
      ) : (
        <p className="text-sm text-amber-700">Адрес создаётся в Circle…</p>
      )}
    </Card>
  );
}
