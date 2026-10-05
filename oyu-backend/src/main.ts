import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { json, urlencoded } from 'express';

import { AppModule } from './app.module';
import { env } from './config/env';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // ── Global prefix ──
  app.setGlobalPrefix('api/v1');

  // ── Body limits (100 KB для JSON) ──
  // Исключения: сканы бумажных бланков (до 12 МБ изображение) и импорт/изображения банков вопросов
  app.use('/api/v1/admin/paper', json({ limit: '18mb' }));
  app.use('/api/v1/teacher/question-banks', json({ limit: '8mb' }));
  app.use(json({ limit: '100kb' }));
  app.use(urlencoded({ extended: true, limit: '100kb' }));

  // ── Security headers ──
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: [`'self'`],
          scriptSrc: [`'self'`],
          styleSrc: [`'self'`, `'unsafe-inline'`],
          imgSrc: [`'self'`, `data:`, `https:`],
          connectSrc: [`'self'`],
          fontSrc: [`'self'`, `https:`, `data:`],
          objectSrc: [`'none'`],
          frameAncestors: [`'none'`],
          baseUri: [`'self'`],
          formAction: [`'self'`],
          upgradeInsecureRequests: env.NODE_ENV === 'production' ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
      hsts:
        env.NODE_ENV === 'production'
          ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
          : false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );

  app.use(cookieParser());

  // ── CORS ──
  const origins = env.FRONTEND_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
  app.enableCors({
    origin: origins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Lang', 'X-View-As', 'X-Workstation-Key'],
    exposedHeaders: ['X-View-As'],
  });

  // ── Trust proxy (Railway / behind LB) ──
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // ── Global filter ──
  app.useGlobalFilters(new AllExceptionsFilter());

  await app.listen(env.PORT, '0.0.0.0');

  const logger = new Logger('Bootstrap');
  logger.log(`🚀 Academic Portal API running on :${env.PORT} (${env.NODE_ENV})`);
  logger.log(`🔐 CORS origins: ${origins.join(', ')}`);
  logger.log(`📡 Base path: /api/v1`);
}

bootstrap();
