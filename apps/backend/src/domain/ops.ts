/**
 * Ops-обзор: где лежат деньги и сходится ли леджер. Нужен для демонстрации omnibus-модели и для эксплуатации:
 * ликвидность treasury, не сметённые депозиты, house float, тождество леджера, очередь задач, сверка с on-chain.
 */
import { formatUnits, type OpsOverviewDto, type OpsTokenOverviewDto } from '@circle-wallet/shared';
import { sql } from 'kysely';
import type { AppContext } from './context';
import { getTreasuryWallet } from './wallets';

export async function getOpsOverview(ctx: AppContext): Promise<OpsOverviewDto> {
  const treasury = await getTreasuryWallet(ctx.db);

  const accounts = await ctx.db
    .selectFrom('app.ledger_accounts as a')
    .leftJoin('app.wallets as w', 'w.id', 'a.wallet_id')
    .select(['a.type', 'a.token', 'a.balance', 'w.kind as wallet_kind'])
    .execute();
  const inFlight = await ctx.db
    .selectFrom('app.withdrawals')
    .select(['token', sql<string>`coalesce(sum(amount), 0)::text`.as('total')])
    .where('status', 'in', ['SUBMITTING', 'SUBMITTED'])
    .groupBy('token')
    .execute();

  const tokens: OpsTokenOverviewDto[] = ctx.tokens.all().map((token) => {
    const sum = (predicate: (a: (typeof accounts)[number]) => boolean) =>
      accounts.filter((a) => a.token === token.symbol && predicate(a)).reduce((acc, a) => acc + BigInt(a.balance), 0n);
    const custodyTotal = sum((a) => a.type === 'CUSTODY');
    const treasuryCustody = sum((a) => a.type === 'CUSTODY' && a.wallet_kind === 'TREASURY');
    const unswept = sum((a) => a.type === 'CUSTODY' && a.wallet_kind === 'DEPOSIT');
    const available = sum((a) => a.type === 'USER_AVAILABLE');
    const held = sum((a) => a.type === 'USER_HELD');
    const houseBalance = sum((a) => a.type === 'HOUSE');
    const inFlightTotal = BigInt(inFlight.find((r) => r.token === token.symbol)?.total ?? '0');
    const fmt = (v: bigint) => formatUnits(v, token.decimals);
    return {
      token: token.symbol,
      decimals: token.decimals,
      custodyTotal: fmt(custodyTotal),
      treasuryCustody: fmt(treasuryCustody),
      inFlightWithdrawals: fmt(inFlightTotal),
      treasuryLiquidity: fmt(treasuryCustody - inFlightTotal),
      unsweptDeposits: fmt(unswept),
      usersAvailable: fmt(available),
      usersHeld: fmt(held),
      house: fmt(houseBalance),
      ledgerBalanced: custodyTotal === available + held + houseBalance,
    };
  });

  const jobCounts = await ctx.db
    .selectFrom('app.jobs')
    .select(['status', sql<number>`count(*)::int`.as('count')])
    .where('status', 'in', ['PENDING', 'RUNNING', 'DEAD'])
    .groupBy('status')
    .execute();
  const countOf = (status: string) => jobCounts.find((j) => j.status === status)?.count ?? 0;

  const deadJobs = await ctx.db
    .selectFrom('app.jobs')
    .select(['id', 'kind', 'attempts', 'last_error', 'updated_at'])
    .where('status', '=', 'DEAD')
    .orderBy('updated_at', 'desc')
    .limit(20)
    .execute();

  const balanceChecks = await ctx.db
    .selectFrom('app.balance_checks as b')
    .innerJoin('app.wallets as w', 'w.id', 'b.wallet_id')
    .select(['b.wallet_id', 'w.kind', 'w.address', 'b.token', 'b.ledger_custody', 'b.in_flight_out', 'b.on_chain', 'b.checked_at'])
    .orderBy('w.kind', 'desc')
    .orderBy('b.checked_at', 'desc')
    .limit(100)
    .execute();

  const sweeps = await ctx.db
    .selectFrom('app.sweeps as s')
    .innerJoin('app.wallets as w', 'w.id', 's.wallet_id')
    .select(['s.id', 'w.address', 's.token', 's.amount', 's.status', 's.circle_state', 's.tx_hash', 's.created_at', 's.completed_at'])
    .orderBy('s.created_at', 'desc')
    .limit(20)
    .execute();

  const inbounds = await ctx.db
    .selectFrom('app.treasury_inbounds')
    .selectAll()
    .orderBy('created_at', 'desc')
    .limit(20)
    .execute();

  const decimalsOf = (symbol: string) => ctx.tokens.bySymbol(symbol)?.decimals ?? 6;

  return {
    treasury: treasury ? { walletId: treasury.id, address: treasury.address, status: treasury.status } : null,
    blockchain: ctx.settings.blockchain,
    tokens,
    jobs: { pending: countOf('PENDING'), running: countOf('RUNNING'), dead: countOf('DEAD') },
    deadJobs: deadJobs.map((j) => ({
      id: String(j.id),
      kind: j.kind,
      attempts: j.attempts,
      lastError: j.last_error,
      updatedAt: j.updated_at.toISOString(),
    })),
    balanceChecks: balanceChecks.map((b) => {
      const d = decimalsOf(b.token);
      return {
        walletId: b.wallet_id,
        walletKind: b.kind,
        address: b.address,
        token: b.token,
        ledgerCustody: formatUnits(BigInt(b.ledger_custody), d),
        inFlightOut: formatUnits(BigInt(b.in_flight_out), d),
        onChain: formatUnits(BigInt(b.on_chain), d),
        difference: formatUnits(BigInt(b.on_chain) - (BigInt(b.ledger_custody) - BigInt(b.in_flight_out)), d),
        checkedAt: b.checked_at.toISOString(),
      };
    }),
    recentSweeps: sweeps.map((s) => ({
      id: s.id,
      walletAddress: s.address,
      token: s.token,
      amount: formatUnits(BigInt(s.amount), decimalsOf(s.token)),
      status: s.status,
      circleState: s.circle_state,
      txHash: s.tx_hash,
      createdAt: s.created_at.toISOString(),
      completedAt: s.completed_at?.toISOString() ?? null,
    })),
    recentTreasuryInbounds: inbounds.map((i) => ({
      id: i.id,
      token: i.token,
      amount: formatUnits(BigInt(i.amount), decimalsOf(i.token)),
      classification: i.classification,
      sourceAddress: i.source_address,
      txHash: i.tx_hash,
      circleState: i.circle_state,
      createdAt: i.created_at.toISOString(),
    })),
  };
}
