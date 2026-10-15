import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Корень репозитория (apps/backend/scripts/lib → ../../../../). */
export const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
export const envFilePath = `${repoRoot}.env`;

/**
 * Записывает значения в корневой .env, сохраняя комментарии и порядок строк.
 * Существующий ключ заменяется, отсутствующий дописывается в конец.
 */
export function upsertEnvValues(values: Record<string, string>): void {
  if (!existsSync(envFilePath)) {
    throw new Error(`Не найден ${envFilePath}. Создайте его: cp .env.example .env`);
  }
  const lines = readFileSync(envFilePath, 'utf8').split('\n');
  const pending = new Map(Object.entries(values));
  const updated = lines.map((line) => {
    const match = /^([A-Z0-9_]+)=/.exec(line);
    const key = match?.[1];
    if (key && pending.has(key)) {
      const value = pending.get(key)!;
      pending.delete(key);
      return `${key}=${value}`;
    }
    return line;
  });
  for (const [key, value] of pending) updated.push(`${key}=${value}`);
  writeFileSync(envFilePath, updated.join('\n'));
}
