import { UserWalletPage } from '@/components/wallet/user-wallet-page';

// Серверная часть только достаёт id из URL; все данные грузятся на клиенте через React Query.
export default async function UserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <UserWalletPage userId={id} />;
}
