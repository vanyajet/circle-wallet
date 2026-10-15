import path from 'node:path';
import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';

// Единый .env лежит в корне монорепо; cwd при запуске через `pnpm --filter` — apps/web.
const repoRoot = path.resolve(process.cwd(), '../..');
loadEnvConfig(repoRoot);

const nextConfig: NextConfig = {
  // shared экспортирует исходники TypeScript без сборки.
  transpilePackages: ['@circle-wallet/shared'],
  // Явный корень монорепо: иначе Next может выбрать внешний lockfile (например, при запуске из git worktree).
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  // Next 16 по умолчанию генерирует AGENTS.md для AI-агентов при next dev — в репозитории он не нужен.
  agentRules: false,
};

export default nextConfig;
