import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Интеграционные тесты поднимают Postgres в Docker (testcontainers) — даём время на старт контейнера.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Каждый файл интеграционных тестов поднимает свою БД; параллелим по файлам.
    fileParallelism: true,
  },
});
