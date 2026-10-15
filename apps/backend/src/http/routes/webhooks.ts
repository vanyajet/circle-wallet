/**
 * Приём вебхуков Circle (ADR-0006).
 *
 * Только быстрые и надёжные шаги: проверить подпись → записать в inbox → 200.
 * Обработка — в worker (задача webhook.process). Ответ за миллисекунды, Circle ждёт ~5 с.
 */
import express, { Router } from 'express';
import { NotificationEnvelopeSchema } from '../../circle/schemas';
import type { WebhookSignatureVerifier } from '../../circle/webhook-signature';
import type { AppContext } from '../../domain/context';
import { ingestWebhook } from '../../domain/webhooks';

export function webhooksRouter(ctx: AppContext, verifier: WebhookSignatureVerifier): Router {
  const router = Router();
  const log = ctx.logger.child({ component: 'webhooks' });

  // Circle проверяет URL HEAD-запросом при создании/изменении подписки. Express сам не ответит на HEAD для POST-роута.
  router.head('/webhooks/circle', (_req, res) => {
    res.sendStatus(200);
  });

  // express.raw — только здесь: подпись считается от сырых байтов тела, JSON-парсер их бы потерял.
  router.post('/webhooks/circle', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const signature = req.header('x-circle-signature');
    const keyId = req.header('x-circle-key-id');
    const rawBody = req.body as unknown;
    if (!signature || !keyId || !Buffer.isBuffer(rawBody) || rawBody.length === 0) {
      log.warn({ hasSignature: !!signature, hasKeyId: !!keyId }, 'webhook without signature headers rejected');
      res.status(401).json({ error: { code: 'WEBHOOK_SIGNATURE_INVALID', message: 'Missing signature' } });
      return;
    }

    let valid: boolean;
    try {
      valid = await verifier.verify(rawBody, signature, keyId);
    } catch (err) {
      // Не смогли получить публичный ключ (Circle/сеть недоступны) — 503, чтобы Circle повторил доставку позже.
      log.error({ err, keyId }, 'cannot verify webhook signature (public key unavailable)');
      res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Signature verification unavailable' } });
      return;
    }
    if (!valid) {
      log.warn({ keyId }, 'webhook signature invalid');
      res.status(401).json({ error: { code: 'WEBHOOK_SIGNATURE_INVALID', message: 'Invalid signature' } });
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString('utf8'));
    } catch {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON' } });
      return;
    }
    const envelope = NotificationEnvelopeSchema.safeParse(json);
    if (!envelope.success) {
      // Подпись верна — это настоящее событие Circle неожиданной формы. 4xx не поможет (повтор будет тем же),
      // поэтому подтверждаем и громко логируем; данные транзакций догонит reconciliation.
      log.error({ issues: envelope.error.issues, body: rawBody.toString('utf8').slice(0, 4_000) }, 'signed webhook has unexpected envelope');
      res.status(200).json({ received: true });
      return;
    }

    // Тестовое уведомление: подтверждаем без побочных эффектов (у него бывают нулевые id — до dedupe).
    if (envelope.data.notificationType === 'webhooks.test') {
      log.info('webhooks.test received');
      res.status(200).json({ received: true });
      return;
    }

    try {
      const outcome = await ingestWebhook(ctx, envelope.data);
      log.info(
        { notificationId: envelope.data.notificationId, type: envelope.data.notificationType, outcome },
        'webhook stored',
      );
      res.status(200).json({ received: true });
    } catch (err) {
      // БД недоступна — не 2xx, Circle повторит доставку; событие не потеряется.
      log.error({ err }, 'failed to store webhook');
      res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Temporarily unavailable' } });
    }
  });

  return router;
}
