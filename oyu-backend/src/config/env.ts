import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),

  DATABASE_URL: z.string().url(),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be ≥ 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be ≥ 32 chars'),
  JWT_ACCESS_TTL: z.string().regex(/^\d+(s|m|h|d)$/, 'format: 15m / 1h / 7d').default('15m'),
  JWT_REFRESH_TTL: z.string().regex(/^\d+(s|m|h|d)$/, 'format: 15m / 1h / 7d').default('7d'),

  FRONTEND_ORIGIN: z.string().default('http://localhost:3000'),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().default(100),
  RATE_LIMIT_AI_MAX: z.coerce.number().default(30),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().default(10),

  // По умолчанию: true в production, false в остальных средах (см. ниже)
  COOKIE_SECURE: z.union([z.literal('true'), z.literal('false')]).optional(),

  // 'none' нужен, если фронт и API на разных сайтах (требует COOKIE_SECURE=true)
  COOKIE_SAMESITE: z.enum(['strict', 'lax', 'none']).default('strict'),

  // Academic Journal: пороги предупреждений (шкала 100 баллов; 51 — проходной по университетской шкале A–F)
  JOURNAL_PASS_MARK: z.coerce.number().min(0).max(100).default(51),
  JOURNAL_LOW_ATTENDANCE: z.coerce.number().min(0).max(100).default(75),

  // Public demo: DEMO_MODE=true включает сброс демо-базы; DEMO_RESET_TOKEN — секрет владельца (не публиковать)
  // Экзамены: подсети (CIDR через запятую), из которых разрешены экзаменационные ПК. Пусто — проверка сети отключена (остаётся ключ ПК + токен)
  EXAM_ALLOWED_NETWORKS: z.string().default(''),

  DEMO_MODE: z.union([z.literal('true'), z.literal('false')]).transform((v) => v === 'true').default('false'),
  // пустая строка = не задан (так документировано в .env.example и подставляется docker compose)
  DEMO_RESET_TOKEN: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(16).optional()),

  // Явные осознанные исключения для NODE_ENV=production (локальный docker-демо по http://localhost).
  // На реальном развёртывании оба должны быть false.
  ALLOW_DEMO_IN_PRODUCTION: z.union([z.literal('true'), z.literal('false')]).transform((v) => v === 'true').default('false'),
  ALLOW_INSECURE_COOKIES: z.union([z.literal('true'), z.literal('false')]).transform((v) => v === 'true').default('false'),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // AI assistant (Anthropic / stub)
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-sonnet-5-5'),
  AI_MAX_TOKENS: z.coerce.number().int().positive().default(1500),
  AI_STUB_MODE: z
    .union([z.literal('true'), z.literal('false')])
    .transform((v) => v === 'true')
    .optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment variables:');
  // eslint-disable-next-line no-console
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const raw = parsed.data;
export const env = { ...raw, COOKIE_SECURE: raw.COOKIE_SECURE ? raw.COOKIE_SECURE === 'true' : raw.NODE_ENV === 'production' };
export type Env = typeof env;

/**
 * Небезопасные комбинации конфигурации → отказ запуска (fail-fast), а не тихая работа.
 * Возвращает список проблем; пусто — конфигурация допустима. Вынесено в функцию для unit-тестов.
 */
export function insecureConfigProblems(e: Env): string[] {
  const p: string[] = [];
  if (e.COOKIE_SAMESITE === 'none' && !e.COOKIE_SECURE) p.push('COOKIE_SAMESITE=none requires COOKIE_SECURE=true');
  if (e.JWT_ACCESS_SECRET === e.JWT_REFRESH_SECRET) p.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ');
  if (e.NODE_ENV !== 'production') return p;
  if (/change_me/i.test(e.JWT_ACCESS_SECRET + e.JWT_REFRESH_SECRET)) p.push('JWT secrets still contain the example placeholder');
  if (e.DEMO_MODE && !e.ALLOW_DEMO_IN_PRODUCTION) p.push('DEMO_MODE=true in production requires explicit ALLOW_DEMO_IN_PRODUCTION=true');
  if (!e.COOKIE_SECURE && !e.ALLOW_INSECURE_COOKIES) p.push('COOKIE_SECURE=false in production requires explicit ALLOW_INSECURE_COOKIES=true');
  if (!e.DEMO_MODE && !e.EXAM_ALLOWED_NETWORKS.trim()) p.push('EXAM_ALLOWED_NETWORKS (CIDR list) is required in production unless DEMO_MODE');
  if (e.FRONTEND_ORIGIN.split(',').some((o) => o.trim() === '*')) p.push('FRONTEND_ORIGIN must not be "*" (credentials are used)');
  return p;
}

const problems = insecureConfigProblems(env);
if (problems.length) {
  // eslint-disable-next-line no-console
  console.error('❌ Insecure configuration:\n - ' + problems.join('\n - '));
  if (raw.NODE_ENV !== 'test') process.exit(1);
}
