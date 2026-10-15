/**
 * Долгоживущее LISTEN-соединение к Postgres с автопереподключением.
 *
 * Используется api (канал app_events → SSE) и worker (канал app_jobs → мгновенное пробуждение).
 * Работает только через session pooler / прямое соединение: в transaction mode LISTEN не поддерживается.
 * Соединение может «тихо» умереть (сеть, рестарт pooler'а) — поэтому раз в 30 с шлём SELECT 1
 * и при ошибке переподключаемся; после переподключения вызываем onReconnect (уведомления за время
 * разрыва могли потеряться — подписчики должны перечитать состояние).
 */
import pg from 'pg';
import type { Logger } from '../lib/logger';

export interface PgListenerOptions {
  connection: pg.ClientConfig;
  channels: string[];
  logger: Logger;
  onNotification: (channel: string, payload: string | undefined) => void;
  onReconnect?: () => void;
}

export class PgListener {
  private client: pg.Client | null = null;
  private stopped = false;
  private heartbeat: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private everConnected = false;

  constructor(private readonly options: PgListenerOptions) {}

  async start(): Promise<void> {
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    await this.client?.end().catch(() => undefined);
    this.client = null;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client(this.options.connection);
    client.on('notification', (msg) => this.options.onNotification(msg.channel, msg.payload));
    client.on('error', (err) => {
      this.options.logger.warn({ err }, 'LISTEN connection error');
      void this.reconnect(client);
    });
    client.on('end', () => void this.reconnect(client));

    try {
      await client.connect();
      for (const channel of this.options.channels) await client.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
    } catch (err) {
      this.options.logger.warn({ err }, 'LISTEN connect failed');
      await client.end().catch(() => undefined);
      void this.reconnect(client);
      return;
    }

    this.client = client;
    this.reconnectAttempt = 0;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      client.query('SELECT 1').catch((err) => {
        this.options.logger.warn({ err }, 'LISTEN heartbeat failed');
        void this.reconnect(client);
      });
    }, 30_000);
    this.options.logger.info({ channels: this.options.channels }, 'LISTEN connected');
    if (this.everConnected) this.options.onReconnect?.();
    this.everConnected = true;
  }

  private reconnecting = false;

  private async reconnect(failed: pg.Client): Promise<void> {
    if (this.stopped || this.reconnecting || (this.client && this.client !== failed)) return;
    this.reconnecting = true;
    this.client = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    failed.removeAllListeners();
    failed.end().catch(() => undefined);
    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt++);
    await new Promise((r) => setTimeout(r, delay));
    this.reconnecting = false;
    await this.connect();
  }
}
