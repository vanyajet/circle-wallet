import type { OpsDeadJobDto, OpsJobStatsDto } from '@circle-wallet/shared';
import { formatDateTime } from '@/lib/format';
import { Card } from '../card';
import { EmptyRow, Table, Td } from '../table';

function Stat({ label, value, alert = false }: { label: string; value: number; alert?: boolean }) {
  return (
    <div className="rounded border border-gray-200 px-4 py-2">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-xl font-semibold tabular-nums ${alert ? 'text-red-700' : ''}`}>{value}</div>
    </div>
  );
}

export function JobsCard({ jobs, deadJobs }: { jobs: OpsJobStatsDto; deadJobs: OpsDeadJobDto[] }) {
  return (
    <Card title="Очередь задач">
      <div className="mb-4 flex flex-wrap gap-3">
        <Stat label="В очереди" value={jobs.pending} />
        <Stat label="Выполняются" value={jobs.running} />
        <Stat label="Dead" value={jobs.dead} alert={jobs.dead > 0} />
      </div>
      <h3 className="mb-2 text-sm font-medium">Dead-задачи</h3>
      <Table head={['Тип', 'Попыток', 'Последняя ошибка', 'Обновлена']}>
        {deadJobs.length === 0 && <EmptyRow colSpan={4}>Нет</EmptyRow>}
        {deadJobs.map((job) => (
          <tr key={job.id}>
            <Td className="whitespace-nowrap font-mono text-xs">{job.kind}</Td>
            <Td className="tabular-nums">{job.attempts}</Td>
            <Td className="max-w-md break-words text-xs text-red-700">{job.lastError ?? '—'}</Td>
            <Td className="whitespace-nowrap text-gray-600">{formatDateTime(job.updatedAt)}</Td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}
