import { shortenHex, txExplorerUrl } from '@/lib/format';
import { CopyButton } from './copy-button';

/** Сокращённый адрес (полный — в title) с кнопкой копирования. */
export function ShortAddress({ address, copy = true }: { address: string | null; copy?: boolean }) {
  if (!address) return <span className="text-gray-400">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-mono text-xs" title={address}>
        {shortenHex(address)}
      </span>
      {copy && <CopyButton value={address} />}
    </span>
  );
}

/** Сокращённый хэш транзакции со ссылкой на Basescan. */
export function TxHashLink({ hash }: { hash: string | null }) {
  if (!hash) return <span className="text-gray-400">—</span>;
  return (
    <a
      href={txExplorerUrl(hash)}
      target="_blank"
      rel="noreferrer"
      title={hash}
      className="font-mono text-xs text-blue-700 hover:underline"
    >
      {shortenHex(hash)}
    </a>
  );
}
