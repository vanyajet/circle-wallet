/**
 * Одноразовая регистрация entity secret в Circle.
 *
 *   pnpm circle:register-secret
 *
 * Берёт CIRCLE_API_KEY и CIRCLE_ENTITY_SECRET из .env, шифрует секрет публичным ключом Circle и регистрирует его.
 * Circle возвращает recovery file — он единственный способ восстановить доступ при утере секрета и
 * скачивается ОДИН раз. Файл сохраняется в ./secrets (в .gitignore) — перенесите его в надёжное место.
 *
 * Здесь намеренно используется официальный SDK: эндпоинта регистрации нет в публичной OpenAPI-спеке,
 * а скрипт одноразовый — в рантайме приложения SDK не используется (см. ADR-0007).
 * Повторная регистрация вернёт 409 «The secret for this entity has already been set» — это нормально.
 */
import { mkdirSync, readdirSync } from 'node:fs';
import { registerEntitySecretCiphertext } from '@circle-fin/developer-controlled-wallets';
import { loadCircleConfig } from '../src/config';
import { repoRoot } from './lib/env-file';

const config = loadCircleConfig();
const secretsDir = `${repoRoot}secrets`;
mkdirSync(secretsDir, { recursive: true, mode: 0o700 });

try {
  await registerEntitySecretCiphertext({
    apiKey: config.CIRCLE_API_KEY,
    entitySecret: config.CIRCLE_ENTITY_SECRET,
    baseUrl: config.CIRCLE_BASE_URL,
    recoveryFileDownloadPath: secretsDir,
  });
  const files = readdirSync(secretsDir).filter((f) => f.startsWith('recovery_file'));
  console.log('Entity secret зарегистрирован.');
  console.log(`Recovery file: ${secretsDir}/${files.at(-1) ?? '(не найден — проверьте папку)'}`);
  console.log('Перенесите recovery file в надёжное место вне репозитория.');
} catch (error) {
  const e = error as { status?: number; code?: number; message?: string };
  if (e.status === 409 || e.code === 156015) {
    console.log('Entity secret уже зарегистрирован для этого аккаунта — ничего делать не нужно.');
    process.exit(0);
  }
  console.error(`Не удалось зарегистрировать entity secret: ${e.message ?? String(error)}`);
  process.exit(1);
}
