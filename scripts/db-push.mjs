// Применяет миграции из supabase/migrations к базе из DATABASE_URL через Supabase CLI.
// Обёртка нужна, чтобы строка подключения бралась из .env, а не вводилась руками
// и не попадала в историю shell.
import { spawnSync } from 'node:child_process';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL не задан. Заполните .env (см. .env.example).');
  process.exit(1);
}

const result = spawnSync('supabase', ['db', 'push', '--db-url', url, '--include-all', '--yes', ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
