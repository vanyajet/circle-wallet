/**
 * Очередь задач на Postgres (ADR-0005).
 *
 *  - enqueue вызывается в той же транзакции, что и бизнес-изменение (transactional outbox):
 *    если транзакция откатилась — задачи нет, если закоммитилась — задача гарантированно есть;
 *  - claim захватывает задачи через FOR UPDATE SKIP LOCKED с lease по часам БД;
 *    задача с истёкшим lease (воркер умер) захватывается снова;
 *  - complete/retry/... применяются только если воркер всё ещё владеет задачей (fencing по locked_by):
 *    результат «опоздавшего» воркера, чей lease уже перехватили, не перетрёт чужой.
 */
import { sql } from 'kysely';
import { isUniqueViolation } from '../db/errors';
import type { Db, DbExecutor } from '../db/client';
import type { Job } from '../db/schema';

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
  runAt?: Date;
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
      coalesce(${options.runAt ?? null}::timestamptz, now()),
      ${options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS[kind]}
    )`.execute(db);
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

export async function completeJob(db: Db, job: Job, workerId: string): Promise<void> {
  await db
    .updateTable('app.jobs')
    .set({ status: 'DONE', finished_at: new Date(), locked_by: null, locked_until: null, last_error: null })
    .where('id', '=', job.id)
    .where('locked_by', '=', workerId)
    .where('status', '=', 'RUNNING')
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
        run_at: new Date(Date.now() + delayMs),
        locked_by: null,
        locked_until: null,
        last_error: error,
        ...(consumeAttempt ? {} : { attempts: sql<number>`greatest(attempts - 1, 0)` }),
      })
      .where('id', '=', job.id)
      .where('locked_by', '=', workerId)
      .where('status', '=', 'RUNNING')
      .execute();
  } catch (e) {
    // Пока задача выполнялась, поставили такую же (dedupe_key свободен для PENDING) — эта больше не нужна.
    if (isUniqueViolation(e, 'jobs_dedupe_pending')) {
      await db
        .updateTable('app.jobs')
        .set({ status: 'DONE', finished_at: new Date(), locked_by: null, locked_until: null, last_error: 'superseded' })
        .where('id', '=', job.id)
        .where('locked_by', '=', workerId)
        .execute();
      return;
    }
    throw e;
  }
}

export async function killJob(db: Db, job: Job, workerId: string | null, error: string): Promise<void> {
  let query = db
    .updateTable('app.jobs')
    .set({ status: 'DEAD', finished_at: new Date(), locked_by: null, locked_until: null, last_error: error })
    .where('id', '=', job.id);
  if (workerId) query = query.where('locked_by', '=', workerId);
  await query.execute();
}

/**
 * Разбудить ожидающие задачи вида kind прямо сейчас (например, выводы, ждущие ликвидности,
 * после того как sweep или house float её добавили). Вызывается внутри бизнес-транзакции.
 */
export async function wakeJobs(db: DbExecutor, kind: JobKind): Promise<void> {
  await db
    .updateTable('app.jobs')
    .set({ run_at: sql<Date>`now()` })
    .where('kind', '=', kind)
    .where('status', '=', 'PENDING')
    .where('run_at', '>', sql<Date>`now()`)
    .execute();
}
