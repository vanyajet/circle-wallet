'use client';

import { useQueryClient } from '@tanstack/react-query';
import { queryKeys, useOpsOverview } from '@/lib/queries';
import { useEventStream } from '@/lib/use-event-stream';
import { ErrorMessage, Loading } from '../query-state';
import { BalanceChecksTable } from './balance-checks-table';
import { JobsCard } from './jobs-card';
import { TokenOverviewTable } from './token-overview-table';
import { RecentSweepsTable, RecentTreasuryInboundsTable } from './treasury-flows';
import { TreasuryCard } from './treasury-card';

export function OpsDashboard() {
  const queryClient = useQueryClient();
  const overview = useOpsOverview();

  // Глобальный стрим: любое изменение (депозит, вывод, sweep, проводка) влияет на сводку.
  useEventStream('/events', () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.ops });
  });

  if (!overview.data) {
    if (overview.isError) {
      return <ErrorMessage error={overview.error} onRetry={() => void overview.refetch()} />;
    }
    return <Loading />;
  }

  const data = overview.data;
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Ops</h1>
      {overview.isError && <ErrorMessage error={overview.error} onRetry={() => void overview.refetch()} />}
      <TreasuryCard treasury={data.treasury} blockchain={data.blockchain} />
      <TokenOverviewTable tokens={data.tokens} />
      <JobsCard jobs={data.jobs} deadJobs={data.deadJobs} />
      <BalanceChecksTable checks={data.balanceChecks} />
      <RecentSweepsTable sweeps={data.recentSweeps} />
      <RecentTreasuryInboundsTable inbounds={data.recentTreasuryInbounds} />
    </div>
  );
}
