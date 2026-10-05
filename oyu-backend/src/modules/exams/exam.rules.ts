import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { Prisma } from '@prisma/client';

/**
 * Академические правила Exam System — чистые функции без доступа к БД и к времени (время передаётся параметром).
 * Любое решение о допуске, баллах и оплате принимается только здесь и в сервисах backend.
 */

export const TZ = 'Asia/Baku';
export const EXAM_RULES = {
  CORRECT: 2,
  WRONG: -1,
  SKIP: 0,
  QUESTIONS: 25,
  MAX_EXAM_SCORE: 50,
  MIN_EXAM_SCORE: 17,
  PASS_TOTAL: 51,
  OPTIONS: ['A', 'B', 'C', 'D', 'E'] as const,
  VERSION: 1,
} as const;

const D = Prisma.Decimal;

// ───────────────────────── Оценивание ─────────────────────────

export interface ScoreInput {
  /** по каждому вопросу: выбран ли правильный вариант / неправильный / пропуск */
  answers: Array<'CORRECT' | 'WRONG' | 'SKIP'>;
  entryScore: number | string;
}
export type FailReason = 'MIN_EXAM_SCORE' | 'TOTAL_BELOW_PASS' | 'BOTH';
export interface ScoreResult {
  correct: number;
  wrong: number;
  skipped: number;
  examScore: number;
  entryScore: number;
  total: number;
  letter: string;
  passed: boolean;
  failReason: FailReason | null;
}

export function letterFor(total: number): string {
  if (total >= 91) return 'A';
  if (total >= 81) return 'B';
  if (total >= 71) return 'C';
  if (total >= 61) return 'D';
  if (total >= 51) return 'E';
  return 'F';
}

/**
 * Exam Score = +2 за верный, −1 за неверный, 0 за пропуск. Total = Entry + Exam.
 * PASS только если Total >= passTotal И Exam >= minExam. Буква считается отдельно от PASS/FAIL.
 */
export function scoreExam(input: ScoreInput, cfg: { passTotal?: number; minExam?: number } = {}): ScoreResult {
  const passTotal = cfg.passTotal ?? EXAM_RULES.PASS_TOTAL;
  const minExam = cfg.minExam ?? EXAM_RULES.MIN_EXAM_SCORE;
  const correct = input.answers.filter((a) => a === 'CORRECT').length;
  const wrong = input.answers.filter((a) => a === 'WRONG').length;
  const skipped = input.answers.length - correct - wrong;
  const exam = correct * EXAM_RULES.CORRECT + wrong * EXAM_RULES.WRONG;
  const entry = new D(input.entryScore).toDecimalPlaces(2);
  const total = entry.plus(exam);
  const totalN = Number(total.toDecimalPlaces(2));
  const okTotal = totalN >= passTotal;
  const okExam = exam >= minExam;
  const failReason: FailReason | null = okTotal && okExam ? null : !okTotal && !okExam ? 'BOTH' : !okExam ? 'MIN_EXAM_SCORE' : 'TOTAL_BELOW_PASS';
  return { correct, wrong, skipped, examScore: exam, entryScore: Number(entry), total: totalN, letter: letterFor(totalN), passed: !failReason, failReason };
}

/** Итог по готовому Exam Score (тот же порог, что и в scoreExam) — используется при пересмотре по апелляции */
export function evaluateTotals(entryScore: number | string, examScore: number, cfg: { passTotal?: number; minExam?: number } = {}) {
  const passTotal = cfg.passTotal ?? EXAM_RULES.PASS_TOTAL, minExam = cfg.minExam ?? EXAM_RULES.MIN_EXAM_SCORE;
  const total = Number(new D(entryScore).plus(examScore).toDecimalPlaces(2));
  const okTotal = total >= passTotal, okExam = examScore >= minExam;
  const failReason: FailReason | null = okTotal && okExam ? null : !okTotal && !okExam ? 'BOTH' : !okExam ? 'MIN_EXAM_SCORE' : 'TOTAL_BELOW_PASS';
  return { total, letter: letterFor(total), passed: !failReason, failReason };
}

// ───────────────────────── Деньги ─────────────────────────

/** Стоимость 25% пересдачи = кредиты × цена кредита × 0.25 (Decimal, 2 знака). Клиентская сумма не используется. */
export function resitFee(credits: number, creditPrice: number | string, ratio: number | string = 0.25): { full: number; fee: number } {
  const full = new D(credits).times(creditPrice);
  return { full: Number(full.toDecimalPlaces(2)), fee: Number(full.times(ratio).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)) };
}

// ───────────────────────── Время / окно ─────────────────────────

export interface LocalParts {
  /** YYYY-MM-DD в Asia/Baku */
  date: string;
  /** 1 = Пн … 7 = Вс */
  weekday: number;
  minutes: number;
}

const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function localParts(d: Date): LocalParts {
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
  return { date, weekday: wd === 0 ? 7 : wd, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

export const toMinutes = (hhmm: string): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`Bad time ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
};
export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);
export const addDays = (date: string, n: number): string => isoDate(new Date(new Date(`${date}T00:00:00Z`).getTime() + n * 86400000));

export interface WindowLike {
  status: string;
  startDate: Date;
  endDate: Date;
  allowedWeekdays: number[];
  startTime: string;
  endTime: string;
}
export type WindowReason = 'WINDOW_NOT_PUBLISHED' | 'WINDOW_NOT_STARTED' | 'WINDOW_CLOSED' | 'WEEKDAY_NOT_ALLOWED' | 'OUTSIDE_ALLOWED_TIME';

/** Дата и день недели — расписание дня; time=true дополнительно проверяет время старта [startTime, endTime) */
export function checkWindow(w: WindowLike, now: Date, opts: { time?: boolean } = { time: true }): WindowReason | null {
  if (w.status !== 'PUBLISHED') return w.status === 'CLOSED' ? 'WINDOW_CLOSED' : 'WINDOW_NOT_PUBLISHED';
  const lp = localParts(now);
  if (lp.date < isoDate(w.startDate)) return 'WINDOW_NOT_STARTED';
  if (lp.date > isoDate(w.endDate)) return 'WINDOW_CLOSED';
  if (!w.allowedWeekdays.includes(lp.weekday)) return 'WEEKDAY_NOT_ALLOWED';
  if (opts.time !== false && (lp.minutes < toMinutes(w.startTime) || lp.minutes >= toMinutes(w.endTime))) return 'OUTSIDE_ALLOWED_TIME';
  return null;
}

/** Ближайшая допустимая дата окна начиная с now (для вкладки Upcoming); null — больше нет дней */
export function nextAllowedDate(w: WindowLike, now: Date): string | null {
  const start = isoDate(w.startDate), end = isoDate(w.endDate);
  let d = localParts(now).date;
  if (d < start) d = start;
  for (let i = 0; i < 400 && d <= end; i++, d = addDays(d, 1)) {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay() || 7;
    if (w.allowedWeekdays.includes(wd)) return d;
  }
  return null;
}

/** Границы ISO-недели (пн 00:00 — следующий пн 00:00 по Asia/Baku, UTC+4 без перехода на летнее время) */
export function weekRange(now: Date): { from: Date; to: Date } {
  const lp = localParts(now);
  const monday = addDays(lp.date, -(lp.weekday - 1));
  const from = new Date(`${monday}T00:00:00+04:00`);
  return { from, to: new Date(from.getTime() + 7 * 86400000) };
}

/** Resit-окно по умолчанию: начинается ровно через неделю после окончания финального, будни, то же время */
export function defaultResitWindow(final: { endDate: Date; startDate: Date; startTime: string; endTime: string }): { startDate: string; endDate: string; allowedWeekdays: number[]; startTime: string; endTime: string } {
  const finalEnd = isoDate(final.endDate);
  const start = addDays(finalEnd, 7); // ровно через неделю после окончания финального окна
  return { startDate: start, endDate: addDays(start, 13), allowedWeekdays: [1, 2, 3, 4, 5], startTime: final.startTime, endTime: final.endTime };
}

// ───────────────────────── Цикл ─────────────────────────

export const cycleKey = (academicYear: string, term: string) => `${academicYear}:${term}`;

// ───────────────────────── Безопасность ─────────────────────────

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const newSecret = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** Детерминированный launch token: HMAC(secret, authId|workstation|student|exam|expiresAt) — привязан ко всем полям */
export function launchToken(secret: string, a: { id: string; workstationId: string; studentId: string; examId: string; expiresAt: Date }): string {
  return createHmac('sha256', secret).update([a.id, a.workstationId, a.studentId, a.examId, a.expiresAt.getTime()].join('|')).digest('base64url');
}
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Криптографически стойкое перемешивание (Fisher–Yates, crypto.randomInt) */
export function shuffle<T>(arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Нормализованный хеш содержимого вопроса — защита от дубликатов в одной версии банка */
export function questionHash(body: string, options: string[]): string {
  const n = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  return sha256([n(body), ...options.map(n).sort()].join('\u0001'));
}

// ───────────────────────── Сеть ─────────────────────────

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.some((x) => x > 255) ? null : ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}
/** Принадлежность IP (IPv4 / ::ffff:IPv4 / ::1) любому из CIDR-списка */
export function ipInNetworks(ip: string | undefined | null, cidrs: string[]): boolean {
  if (!ip) return false;
  const clean = ip.replace(/^::ffff:/i, '');
  for (const c of cidrs.map((x) => x.trim()).filter(Boolean)) {
    if (c === clean) return true;
    const [base, bitsRaw] = c.split('/');
    const a = ipv4ToInt(clean), b = ipv4ToInt(base);
    if (a == null || b == null) continue;
    const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if (((a & mask) >>> 0) === ((b & mask) >>> 0)) return true;
  }
  return false;
}
