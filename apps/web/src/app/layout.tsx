import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Circle Wallet',
  description: 'Кастодиальный кошелёк на Circle Developer-Controlled Wallets (BASE-SEPOLIA)',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <header className="border-b border-gray-200 bg-white">
          <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
            <Link href="/" className="text-lg font-semibold">
              Circle Wallet
            </Link>
            <Link href="/" className="text-sm text-gray-700 hover:text-gray-900 hover:underline">
              Пользователи
            </Link>
            <Link href="/ops" className="text-sm text-gray-700 hover:text-gray-900 hover:underline">
              Ops
            </Link>
            <span className="ml-auto text-xs text-gray-500">Сеть: BASE-SEPOLIA (testnet)</span>
          </nav>
        </header>
        <Providers>
          <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
