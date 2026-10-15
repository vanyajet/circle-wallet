/**
 * Runtime воркера: забирает задачи из app.jobs и выполняет их с ограничением параллелизма.
 *
 *  - пробуждение по NOTIFY app_jobs (миллисекунды) + опрос раз в секунду как подстраховка;
 *  - исключение обработчика → retry с exponential backoff и jitter; после max_attempts → DEAD;
 *  - RetryLaterError → retry с указанной задержкой; ошибки конфигурации Circle → длинная пауза;
 *  - graceful shutdown: перестаём брать задачи и ждём текущие; недоделанные подхватятся после истечения lease.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { isCircleError } from '../circle/errors';
import type { AppContext } from '../domain/context';
import { RetryLaterError } from '../domain/context';
import type { Job } from '../db/schema';
import type { Logger } from '../lib/logger';
import type { JobHandler } from './handlers';
import { claimJobs, completeJob, killJob, retryJob, type JobKind } from './queue';

export interface WorkerOptions {
  concurrency: number;
  /** Lease должен быть заметно больше самого долгого обработчика (таймаут Circle 15 с, несколько запросов). */
  leaseSeconds?: number;
  pollIntervalMs?: number;
}

const MAX_BACKOFF_MS = 5 * 60_000;
const CONFIG_ERROR_BACKOFF_MS = 60_000;

export function backoffMs(attempt: number): number {
  const base = Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** Math.max(0, attempt - 1));
  // Jitter ±50%: после массового сбоя задачи не ретраятся одной волной.
  return Math.round(base * (0.5 + Math.random()));
}

export class JobWorker {
  readonly id = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private running = false;
  private readonly active = new Set<Promise<void>>();
  private wakeUp: (() => void) | null = null;
  private loopPromise: Promise<void> | null = null;
  private readonly log: Logger;

  constructor(
    private readonly ctx: AppContext,
    private readonly handlers: Record<JobKind, JobHandler>,
    private readonly options: WorkerOptions,
  ) {
    this.log = ctx.logger.child({ workerId: this.id });
  }

  start(): void {
    this.running = true;
    this.loopPromise = this.loop();
    this.log.info({ concurrency: this.options.concurrency }, 'worker started');
  }

  /** Сигнал «появились задачи» (из LISTEN app_jobs). */
  notify(): void {
    this.wakeUp?.();
  }

  async stop(timeoutMs = 25_000): Promise<void> {
    this.running = false;
    this.wakeUp?.();
    await this.loopPromise;
    const timeout = new Promise((r) => setTimeout(r, timeoutMs));
    await Promise.race([Promise.allSettled([...this.active]), timeout]);
    this.log.info({ unfinished: this.active.size }, 'worker stopped');
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const free = this.options.concurrency - this.active.size;
      let claimed: Job[] = [];
      if (free > 0) {
        try {
          claimed = await claimJobs(this.ctx.db, this.id, free, this.options.leaseSeconds ?? 120);
        } catch (err) {
          this.log.error({ err }, 'failed to claim jobs');
          await this.sleep(5_000);
          continue;
        }
      }
      for (const job of claimed) {
        const run = this.execute(job).finally(() => {
          this.active.delete(run);
          this.wakeUp?.();
        });
        this.active.add(run);
      }
      if (claimed.length === 0 || this.active.size >= this.options.concurrency) {
        await this.sleep(this.options.pollIntervalMs ?? 1_000);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wakeUp = () => {
        this.wakeUp = null;
        done();
      };
    });
  }

  private async execute(job: Job): Promise<void> {
    const log = this.log.child({ jobId: job.id, kind: job.kind, attempt: job.attempts });
    const handler = this.handlers[job.kind as JobKind];
    try {
      if (!handler) {
        await killJob(this.ctx.db, job, this.id, `unknown job kind ${job.kind}`);
        return;
      }
      // Задача, перехваченная после истечения lease, могла уже исчерпать попытки (воркер падал на ней).
      if (job.attempts > job.max_attempts) {
        await killJob(this.ctx.db, job, this.id, job.last_error ?? 'max attempts exceeded');
        log.error('job exceeded max attempts, marked DEAD');
        return;
      }

      const result = await handler(this.ctx, job.payload);
      if (result.type === 'reschedule') {
        await retryJob(this.ctx.db, job, this.id, result.delayMs, result.reason, false);
        log.debug({ delayMs: result.delayMs, reason: result.reason }, 'job rescheduled');
        return;
      }
      await completeJob(this.ctx.db, job, this.id);
      log.debug({ result: result.result }, 'job done');
    } catch (error) {
      await this.handleFailure(job, error, log);
    }
  }

  private async handleFailure(job: Job, error: unknown, log: Logger): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    try {
      if (job.attempts >= job.max_attempts) {
        await killJob(this.ctx.db, job, this.id, message);
        log.error({ err: error }, 'job failed permanently (DEAD)');
        return;
      }
      let delay = backoffMs(job.attempts);
      if (error instanceof RetryLaterError) delay = error.delayMs;
      else if (isCircleError(error) && error.kind === 'CONFIG') delay = Math.max(delay, CONFIG_ERROR_BACKOFF_MS);
      await retryJob(this.ctx.db, job, this.id, delay, message);
      const level = error instanceof RetryLaterError ? 'info' : 'warn';
      log[level]({ err: error, retryInMs: delay }, 'job failed, will retry');
    } catch (persistError) {
      // Не смогли даже записать результат (БД недоступна) — задача вернётся по истечении lease.
      log.error({ err: persistError, original: message }, 'failed to persist job failure');
    }
  }
}
