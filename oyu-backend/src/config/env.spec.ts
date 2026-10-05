import { describe, expect, it } from 'vitest';
import { Env, insecureConfigProblems } from './env';

const base: Env = {
  NODE_ENV: 'production', PORT: 3001, DATABASE_URL: 'postgresql://x@y/z',
  JWT_ACCESS_SECRET: 'a'.repeat(40), JWT_REFRESH_SECRET: 'b'.repeat(40), JWT_ACCESS_TTL: '15m', JWT_REFRESH_TTL: '7d',
  FRONTEND_ORIGIN: 'https://portal.example', RATE_LIMIT_WINDOW_MS: 60000, RATE_LIMIT_MAX: 100, RATE_LIMIT_AI_MAX: 30, RATE_LIMIT_AUTH_MAX: 10,
  COOKIE_SECURE: true, COOKIE_SAMESITE: 'strict', JOURNAL_PASS_MARK: 51, JOURNAL_LOW_ATTENDANCE: 75,
  EXAM_ALLOWED_NETWORKS: '10.20.0.0/16', DEMO_MODE: false, ALLOW_DEMO_IN_PRODUCTION: false, ALLOW_INSECURE_COOKIES: false,
  LOG_LEVEL: 'info', AI_MODEL: 'm', AI_MAX_TOKENS: 100,
} as Env;

describe('insecureConfigProblems', () => {
  it('secure production config passes', () => expect(insecureConfigProblems(base)).toEqual([]));
  it('demo in production needs the explicit flag', () => {
    expect(insecureConfigProblems({ ...base, DEMO_MODE: true })).toHaveLength(1);
    expect(insecureConfigProblems({ ...base, DEMO_MODE: true, ALLOW_DEMO_IN_PRODUCTION: true })).toEqual([]);
  });
  it('insecure cookies in production need the explicit flag', () => {
    expect(insecureConfigProblems({ ...base, COOKIE_SECURE: false })).toHaveLength(1);
    expect(insecureConfigProblems({ ...base, COOKIE_SECURE: false, ALLOW_INSECURE_COOKIES: true })).toEqual([]);
  });
  it('exam networks required in production unless demo', () => {
    expect(insecureConfigProblems({ ...base, EXAM_ALLOWED_NETWORKS: ' ' })[0]).toMatch(/EXAM_ALLOWED_NETWORKS/);
    expect(insecureConfigProblems({ ...base, EXAM_ALLOWED_NETWORKS: '', DEMO_MODE: true, ALLOW_DEMO_IN_PRODUCTION: true })).toEqual([]);
  });
  it('placeholder / identical secrets and wildcard origin are rejected', () => {
    expect(insecureConfigProblems({ ...base, JWT_ACCESS_SECRET: 'change_me_access_secret_at_least_32_chars' })).toHaveLength(1);
    expect(insecureConfigProblems({ ...base, JWT_REFRESH_SECRET: base.JWT_ACCESS_SECRET })).toHaveLength(1);
    expect(insecureConfigProblems({ ...base, FRONTEND_ORIGIN: '*' })).toHaveLength(1);
  });
  it('SameSite=none without Secure is rejected in any env', () => {
    expect(insecureConfigProblems({ ...base, NODE_ENV: 'development', COOKIE_SECURE: false, COOKIE_SAMESITE: 'none' })).toHaveLength(1);
  });
  it('development is permissive', () => {
    expect(insecureConfigProblems({ ...base, NODE_ENV: 'development', DEMO_MODE: true, COOKIE_SECURE: false, EXAM_ALLOWED_NETWORKS: '' })).toEqual([]);
  });
});
