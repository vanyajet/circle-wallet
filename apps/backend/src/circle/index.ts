import { loadCircleConfig, type CircleConfig } from '../config';
import type { Logger } from '../lib/logger';
import { CircleClient } from './client';

export function createCircleClient(logger: Logger, config: CircleConfig = loadCircleConfig()): CircleClient {
  return new CircleClient({
    baseUrl: config.CIRCLE_BASE_URL,
    apiKey: config.CIRCLE_API_KEY,
    entitySecret: config.CIRCLE_ENTITY_SECRET,
    timeoutMs: config.CIRCLE_REQUEST_TIMEOUT_MS,
    logger,
  });
}

export * from './gateway';
export * from './errors';
export { CircleClient, normalizeNotificationTransaction, normalizeRestTransaction } from './client';
