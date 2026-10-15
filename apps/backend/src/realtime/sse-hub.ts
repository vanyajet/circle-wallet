/**
 * Раздача событий SSE-клиентам (ADR-0008).
 *
 * Событие — только сигнал «данные пользователя X устарели» (invalidate); данные клиент перечитывает по REST.
 * Поэтому пропущенное событие безвредно: при (пере)подключении клиент получает `ready` и перечитывает всё,
 * а при обрыве LISTEN-соединения сервер шлёт всем `resync`.
 */
import type { SseEventName, SseInvalidatePayload } from '@circle-wallet/shared';
import type { Request, Response } from 'express';
import type { Logger } from '../lib/logger';

interface Client {
  res: Response;
  /** null — подписка на все события (список пользователей, ops). */
  userId: string | null;
}

const HEARTBEAT_MS = 15_000;
const MAX_CLIENTS = 1_000;

export class SseHub {
  private readonly clients = new Set<Client>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor(private readonly logger: Logger) {
    // Комментарий-пинг держит соединение живым через прокси/балансировщики и помогает заметить мёртвых клиентов.
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) client.res.write(': ping\n\n');
    }, HEARTBEAT_MS);
  }

  subscribe(req: Request, res: Response, userId: string | null): void {
    if (this.clients.size >= MAX_CLIENTS) {
      res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Слишком много SSE-подключений' } });
      return;
    }
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Отключает буферизацию в nginx-подобных прокси — иначе события копятся и приходят пачками.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    // Клиенту: переподключаться через 3 с при обрыве (EventSource делает это сам).
    res.write('retry: 3000\n\n');

    const client: Client = { res, userId };
    this.clients.add(client);
    this.send(client, 'ready', {});
    req.on('close', () => this.clients.delete(client));
  }

  /** Из LISTEN app_events: payload {"userId": "..."|null}. */
  publishInvalidate(payload: SseInvalidatePayload): void {
    for (const client of this.clients) {
      // Глобальные подписчики получают всё; персональные — только свои события.
      if (client.userId === null || client.userId === payload.userId) this.send(client, 'invalidate', payload);
    }
  }

  /** LISTEN-соединение переподключилось — события за время разрыва могли потеряться. */
  publishResync(): void {
    for (const client of this.clients) this.send(client, 'resync', {});
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const client of this.clients) client.res.end();
    this.clients.clear();
  }

  get size(): number {
    return this.clients.size;
  }

  private send(client: Client, event: SseEventName, data: unknown): void {
    try {
      client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      this.logger.debug({ err }, 'SSE write failed, dropping client');
      this.clients.delete(client);
    }
  }
}
