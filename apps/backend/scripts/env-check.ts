/**
 * Проверка .env БЕЗ вывода значений: печатает только, какие переменные заданы, отсутствуют или невалидны.
 * Удобно, чтобы убедиться в готовности окружения, не показывая секреты (в том числе в логах/чатах).
 *
 *   pnpm env:check
 */
import { z } from 'zod';
import { configSections } from '../src/config';

let hasErrors = false;

for (const [section, schema] of Object.entries(configSections)) {
  console.log(`\n[${section}]`);
  const shape = (schema as z.ZodObject).shape;
  const result = (schema as z.ZodObject).safeParse(process.env);
  const issuesByKey = new Map<string, string>();
  if (!result.success) {
    for (const issue of result.error.issues) issuesByKey.set(String(issue.path[0]), issue.message);
  }
  for (const key of Object.keys(shape)) {
    const raw = process.env[key];
    const isSet = raw !== undefined && raw.trim() !== '';
    const issue = issuesByKey.get(key);
    if (issue) {
      hasErrors = true;
      console.log(`  ✗ ${key}: ${isSet ? 'невалидно' : 'не задано'} — ${issue}`);
    } else {
      console.log(`  ${isSet ? '✓' : '·'} ${key}${isSet ? '' : ' (не задано, используется значение по умолчанию или будет заполнено bootstrap)'}`);
    }
  }
}

console.log(hasErrors ? '\nЕсть ошибки конфигурации.' : '\nКонфигурация в порядке.');
process.exit(hasErrors ? 1 : 0);
