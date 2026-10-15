/**
 * Публичный HTTPS-адрес для вебхуков в локальной разработке.
 *
 *   pnpm tunnel        (api должен быть уже запущен: pnpm dev)
 *
 * 1. Запускает cloudflared quick tunnel (бесплатно, без аккаунта) на http://localhost:API_PORT.
 * 2. Ждёт, пока адрес *.trycloudflare.com начнёт отвечать (DNS туннеля появляется не мгновенно).
 * 3. Пересоздаёт подписку Circle на новый адрес — у quick tunnel адрес меняется при каждом перезапуске.
 * Туннель живёт, пока работает скрипт (Ctrl+C — остановить). Если туннель упадёт, вебхуки перестанут
 * приходить, но данные догонит reconciliation (ADR-0006) — просто медленнее.
 */
import { spawn } from 'node:child_process';
import { createCircleClient } from '../src/circle';
import { loadApiConfig } from '../src/config';
import { createLogger } from '../src/lib/logger';
import { upsertEnvValues } from './lib/env-file';
import { subscribeWebhooks, WEBHOOK_PATH } from './lib/subscribe';

const { API_PORT } = loadApiConfig();
const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${API_PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

const stop = () => child.kill('SIGTERM');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => {
  console.log(`cloudflared завершился (code ${code})`);
  process.exit(code ?? 0);
});

const publicUrl = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('cloudflared не выдал адрес за 60 секунд')), 60_000);
  const onData = (chunk: Buffer) => {
    const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(chunk.toString());
    if (match) {
      clearTimeout(timer);
      resolve(match[0]);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
});
console.log(`Туннель: ${publicUrl} → http://localhost:${API_PORT}`);

// Ждём, пока туннель реально начнёт проксировать (HEAD на наш webhook-роут отвечает 200).
for (let attempt = 1; ; attempt++) {
  try {
    const res = await fetch(`${publicUrl}${WEBHOOK_PATH}`, { method: 'HEAD', signal: AbortSignal.timeout(5_000) });
    if (res.ok) break;
    console.log(`Туннель отвечает ${res.status}, ждём api... (попытка ${attempt})`);
  } catch {
    console.log(`Туннель ещё не доступен... (попытка ${attempt})`);
  }
  if (attempt >= 30) throw new Error('Туннель не стал доступен. Запущен ли api (pnpm dev)?');
  await new Promise((r) => setTimeout(r, 2_000));
}

upsertEnvValues({ PUBLIC_API_URL: publicUrl });
await subscribeWebhooks(createCircleClient(createLogger('tunnel')), publicUrl);
console.log('Готово. Вебхуки Circle идут через туннель. Ctrl+C — остановить.');
