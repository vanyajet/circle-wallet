import { pino, type Logger } from 'pino';
import { loadLogConfig } from '../config';

/**
 * Структурированный логгер. Секреты маскируются на уровне логгера (redact),
 * чтобы случайный log.info({ request }) не унёс API key или entity secret в логи.
 */
export function createLogger(name: string): Logger {
  const { LOG_LEVEL, NODE_ENV } = loadLogConfig();
  return pino({
    name,
    level: LOG_LEVEL,
    redact: {
      paths: [
        'apiKey',
        'entitySecret',
        'entitySecretCiphertext',
        '*.apiKey',
        '*.entitySecret',
        '*.entitySecretCiphertext',
        'req.headers.authorization',
        'headers.authorization',
        '*.headers.authorization',
      ],
      censor: '[redacted]',
    },
    ...(NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } } }
      : {}),
  });
}

export type { Logger };
