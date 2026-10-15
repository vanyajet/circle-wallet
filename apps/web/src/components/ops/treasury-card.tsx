import type { OpsOverviewDto } from '@circle-wallet/shared';
import { addressExplorerUrl } from '@/lib/format';
import { Card } from '../card';
import { CopyButton } from '../copy-button';
import { WalletStatusBadge } from '../status-badges';

export function TreasuryCard({
  treasury,
  blockchain,
}: {
  treasury: OpsOverviewDto['treasury'];
  blockchain: string;
}) {
  return (
    <Card title="Treasury" actions={treasury && <WalletStatusBadge status={treasury.status} />}>
      {!treasury ? (
        <p className="text-sm text-amber-700">
          Treasury ещё не создан — выполните <code className="font-mono">pnpm circle:bootstrap</code>.
        </p>
      ) : treasury.address ? (
        <>
          <div className="mb-1 text-xs text-gray-500">Адрес ({blockchain})</div>
          <div className="flex flex-wrap items-center gap-2">
            <code className="break-all font-mono text-sm">{treasury.address}</code>
            <CopyButton value={treasury.address} />
            <a
              href={addressExplorerUrl(treasury.address)}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-blue-700 hover:underline"
            >
              Basescan
            </a>
          </div>
        </>
      ) : (
        <p className="text-sm text-gray-500">Адрес создаётся…</p>
      )}
      <p className="mt-3 text-sm text-gray-600">
        House float: пополните treasury напрямую с faucet.circle.com (Base Sepolia) — средства пойдут на счёт
        HOUSE и дадут ликвидность для выводов до завершения sweep.
      </p>
    </Card>
  );
}
