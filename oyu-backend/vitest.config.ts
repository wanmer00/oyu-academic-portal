import { defineConfig } from 'vitest/config';

// Unit-тесты не ходят в БД; переменные нужны только для валидации src/config/env.ts при импорте
export default defineConfig({
  test: {
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      JWT_ACCESS_SECRET: 'test_access_secret_0123456789abcdef0123',
      JWT_REFRESH_SECRET: 'test_refresh_secret_0123456789abcdef012',
    },
  },
});
