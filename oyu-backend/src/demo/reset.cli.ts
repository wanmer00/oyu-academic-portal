// Сброс демо-базы из командной строки (владелец инфраструктуры):
//   docker compose exec portal-api node dist/demo/reset.cli.js        (в контейнере)
//   npm run demo:reset                                                  (локально)
// Работает только при DEMO_MODE=true — защита от случайного запуска на «боевой» базе.
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { env } from '../config/env';
import { DemoResetService } from './demo-reset.service';

async function main() {
  if (!env.DEMO_MODE) {
    console.error('Refusing to reset: DEMO_MODE is not "true".');
    process.exit(1);
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  try {
    const result = await app.get(DemoResetService).reset();
    console.log('Demo database restored:', result);
  } finally {
    await app.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });