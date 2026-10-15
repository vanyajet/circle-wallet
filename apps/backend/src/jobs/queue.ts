/**
 * Очередь задач на Postgres (ADR-0005).
 *
 *  - enqueue вызывается в той же транзакции, что и бизнес-изменение (transactional outbox):
 *    если транзакция откатилась — задачи нет, если закоммитилась — задача гарантированно есть;
 *  - claim захватывает задачи через FOR UPDATE SKIP LOCKED с lease по часам БД;
 *    задача с истёкшим lease (воркер умер) захватывается снова;
 *  - complete/retry/kill применяются только если воркер всё ещё владеет ИМЕННО ЭТОЙ попыткой
 *    (fencing по locked_by + attempts): результат «опоздавшего» запуска, чей lease уже перехватили
 *    (даже тем же воркером), не перетрёт результат нового запуска.
 *  - все времена (run_at, lease) считаются по часам БД, а не приложения: расхождение часов не ломает расписание.
 */
import { sql, type UpdateQueryBuilder, type UpdateResult } from 'kysely';
import { isUniqueViolation } from '../db/errors';
import type { Db, DbExecutor } from '../db/client';
import type { Database, Job } from '../db/schema';

export type JobKind =
  | 'wallet.create'
  | 'webhook.process'
  | 'withdrawal.submit'
  | 'sweep.schedule'
  | 'treasury-inbound.classify'
  | 'reconcile.pending'
  | 'reconcile.inbound'
  | 'reconcile.balances';

export interface EnqueueOptions {
  /** Не больше одной ОЖИДАЮЩЕЙ задачи с таким ключом (см. миграцию jobs). */
  dedupeKey?: string;
  /** Отложить выполнение (считается от now() БД). */
  delayMs?: number;
  maxAttempts?: number;
}

/** Сколько попыток по умолчанию у разных задач: «неизвестный исход» вывода ретраим долго, сверку — коротко. */
const DEFAULT_MAX_ATTEMPTS: Record<JobKind, number> = {
  'wallet.create': 30,
  'webhook.process': 20,
  'withdrawal.submit': 50,
  'sweep.schedule': 30,
  'treasury-inbound.classify': 60,
  'reconcile.pending': 3,
  'reconcile.inbound': 3,
  'reconcile.balances': 3,
};

const dbNowPlus = (ms: number) => sql<Date>`now() + make_interval(secs => ${Math.max(0, ms) / 1000})`;

export async function enqueueJob(
  db: DbExecutor,
  kind: JobKind,
  payload: Record<string, unknown>,
  options: EnqueueOptions = {},
): Promise<void> {
  await sql`select app.enqueue_job(
      ${kind},
      ${JSON.stringify(payload)}::jsonb,
      ${options.dedupeKey ?? null},
      ${dbNowPlus(options.delayMs ?? 0)},
      ${options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS[kind]}
    )`.execute(db);
}

/**
 * Поставить задачу, только если с таким ключом нет ни ожидающей, ни ВЫПОЛНЯЮЩЕЙСЯ задачи.
 * Нужно reconciliation: обычный dedupe смотрит только на PENDING, и пока задача отправки вывода
 * выполняется (RUNNING), второй запуск того же вывода параллельно был бы вреден.
 */
export async function ensureJob(
  db: DbExecutor,
  kind: JobKind,
  payload: Record<string, unknown>,
  dedupeKey: string,
): Promise<void> {
  const blocking = await db
    .selectFrom('app.jobs')
    .select('id')
    .where('dedupe_key', '=', dedupeKey)
    .where((eb) =>
      eb.or([
        eb('status', 'in', ['PENDING', 'RUNNING']),
        // Недавно умершую задачу не воскрешаем сразу: иначе постоянная ошибка (например, конфигурации)
        // превратится в бесконечный цикл. Через 10 минут — новая серия попыток.
        eb.and([eb('status', '=', 'DEAD'), eb('finished_at', '>', sql<Date>`now() - interval '10 minutes'`)]),
      ]),
    )
    .executeTakeFirst();
  if (!blocking) await enqueueJob(db, kind, payload, { dedupeKey });
}

export async function claimJobs(db: Db, workerId: string, limit: number, leaseSeconds: number): Promise<Job[]> {
  const result = await sql<Job>`
    update app.jobs j
       set status = 'RUNNING',
           locked_by = ${workerId},
           locked_until = now() + make_interval(secs => ${leaseSeconds}),
           attempts = j.attempts + 1
     where j.id in (
             select id from app.jobs
              where (status = 'PENDING' and run_at <= now())
                 or (status = 'RUNNING' and locked_until < now())
              order by run_at, id
              for update skip locked
              limit ${limit}
           )
    returning j.*`.execute(db);
  return result.rows;
}

/** Условие fencing: задача всё ещё у этого воркера и это та же попытка (reclaim увеличивает attempts). */
type JobsUpdate = UpdateQueryBuilder<Database, 'app.jobs', 'app.jobs', UpdateResult>;

function owned(job: Job, workerId: string) {
  return (qb: JobsUpdate) =>
    qb
      .where('id', '=', job.id)
      .where('locked_by', '=', workerId)
      .where('attempts', '=', job.attempts)
      .where('status', '=', 'RUNNING');
}

export async function completeJob(db: Db, job: Job, workerId: string): Promise<void> {
  await db
    .updateTable('app.jobs')
    .set({ status: 'DONE', finished_at: sql<Date>`now()`, locked_by: null, locked_until: null, last_error: null })
    .$call(owned(job, workerId))
    .execute();
}

/**
 * Вернуть задачу в очередь. consumeAttempt=false — ожидание без расхода попыток
 * (например, вывод ждёт ликвидности treasury: это не сбой, а нормальное состояние).
 */
export async function retryJob(
  db: Db,
  job: Job,
  workerId: string,
  delayMs: number,
  error: string | null,
  consumeAttempt = true,
): Promise<void> {
  try {
    await db
      .updateTable('app.jobs')
      .set({
        status: 'PENDING',
        run_at: dbNowPlus(delayMs),
        locked_by: null,
        locked_until: null,
        last_error: error,
        ...(consumeAttempt ? {} : { attempts: sql<number>`greatest(attempts - 1, 0)` }),
      })
      .$call(owned(job, workerId))
      .execute();
  } catch (e) {
    // Пока задача выполнялась, поставили такую же (dedupe_key свободен для PENDING) — эта больше не нужна.
    if (isUniqueViolation(e, 'jobs_dedupe_pending')) {
      await db
        .updateTable('app.jobs')
        .set({ status: 'DONE', finished_at: sql<Date>`now()`, locked_by: null, locked_until: null, last_error: 'superseded' })
        .$call(owned(job, workerId))
        .execute();
      return;
    }
    throw e;
  }
}

export async function killJob(db: Db, job: Job, workerId: string, error: string): Promise<void> {
  await db
    .updateTable('app.jobs')
    .set({ status: 'DEAD', finished_at: sql<Date>`now()`, locked_by: null, locked_until: null, last_error: error })
    .$call(owned(job, workerId))
    .execute();
}

/**
 * Разбудить задачи отправки выводов, ЖДУЩИХ ЛИКВИДНОСТИ (после sweep / house float / освобождения резерва).
 * Будим только их: выводы с неизвестным исходом (SUBMITTING) ретраятся с backoff, и сбрасывать его нельзя —
 * во время сбоя Circle это превратилось бы в шквал повторов.
 */
export async function wakeWithdrawalsAwaitingLiquidity(db: DbExecutor): Promise<void> {
  await sql`
    update app.jobs j
       set run_at = now()
      from app.withdrawals w
     where j.kind = 'withdrawal.submit'
       and j.status = 'PENDING'
       and j.run_at > now()
       and w.id = (j.payload ->> 'withdrawalId')::uuid
       and w.status = 'PENDING'
       and w.awaiting_liquidity`.execute(db);
}

/** Разбудить ожидающие классификации входящих на treasury (после завершения sweep — у него появился txHash). */
export async function wakeTreasuryClassification(db: DbExecutor): Promise<void> {
  await db
    .updateTable('app.jobs')
    .set({ run_at: sql<Date>`now()` })
    .where('kind', '=', 'treasury-inbound.classify')
    .where('status', '=', 'PENDING')
    .where('run_at', '>', sql<Date>`now()`)
    .execute();
}
