import { Prisma } from '@prisma/client';

/**
 * Academic Journal — единственный источник формулы оценивания (backend).
 *
 *   TOTAL = FINAL (0..50) + MIDTERM (0..30) + SEMINAR (0..20)
 *   SEMINAR = AVERAGE(all valid seminar answers, каждый 0..10) × 2, если ответов >= 3
 *
 * Расчёт ведётся точной десятичной арифметикой (Decimal), округление — только для отображения.
 * Фронтенд ничего не считает и получает готовые значения.
 */

const D = Prisma.Decimal;
type Dec = Prisma.Decimal;

export const JOURNAL_RULES = {
  FINAL_MAX: 50,
  MIDTERM_MAX: 30,
  SEMINAR_MAX: 20,
  SEMINAR_ANSWER_MAX: 10,
  SEMINAR_MIN_ANSWERS: 3,
  TOTAL_MAX: 100,
} as const;

/** Типы оценок, входящие в формулу. Остальные (HOMEWORK/PROJECT/QUIZ) — legacy и в Journal не участвуют. */
export const JOURNAL_TYPES = ['SEMINAR', 'MIDTERM', 'FINAL'] as const;
export type JournalComponent = (typeof JOURNAL_TYPES)[number];

export const COMPONENT_MAX: Record<JournalComponent, number> = {
  FINAL: JOURNAL_RULES.FINAL_MAX,
  MIDTERM: JOURNAL_RULES.MIDTERM_MAX,
  SEMINAR: JOURNAL_RULES.SEMINAR_ANSWER_MAX,
};

export type JournalStatus = 'PROVISIONAL' | 'READY' | 'PUBLISHED' | 'LOCKED';
export type JournalAlertCode =
  | 'SEMINAR_INCOMPLETE'
  | 'MISSING_MIDTERM'
  | 'MISSING_FINAL'
  | 'PROVISIONAL'
  | 'UNPUBLISHED'
  | 'EDITED_AFTER_PUBLISH'
  | 'LOW_TOTAL';

type NumLike = Dec | number | string;

/** Округление для отображения: 2 знака, half-up (16.666… → 16.67). Внутренние значения не округляются. */
export function roundDisplay(v: NumLike): number {
  return Number(new D(v).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toString());
}
const exactStr = (v: Dec) => v.toDecimalPlaces(10, Prisma.Decimal.ROUND_HALF_UP).toString();

function isValidAnswer(v: NumLike): boolean {
  try {
    const d = new D(v);
    return d.isFinite() && d.gte(0) && d.lte(JOURNAL_RULES.SEMINAR_ANSWER_MAX);
  } catch {
    return false;
  }
}

export interface SeminarResult {
  /** сколько валидных ответов учтено */
  count: number;
  required: number;
  /** ответов достаточно (>= 3), балл рассчитан */
  eligible: boolean;
  /** сколько ответов ещё не хватает */
  missing: number;
  /** среднее по ответам (для UI 2 знака), null если ответов нет */
  average: number | null;
  averageExact: string | null;
  /** SEMINAR score /20 (2 знака), null пока не eligible */
  score: number | null;
  scoreExact: string | null;
  max: number;
  /** сколько переданных значений отброшено как невалидные */
  invalidIgnored: number;
}

/** SEMINAR = AVERAGE(all valid answers) × 2, только при >= 3 валидных ответах. Использует ВСЕ ответы (4, 5, 10…). */
export function calculateSeminarScore(answers: NumLike[]): SeminarResult {
  const valid = answers.filter(isValidAnswer).map((a) => new D(a));
  const count = valid.length;
  const required = JOURNAL_RULES.SEMINAR_MIN_ANSWERS;
  const base = {
    count,
    required,
    missing: Math.max(0, required - count),
    max: JOURNAL_RULES.SEMINAR_MAX,
    invalidIgnored: answers.length - count,
  };
  const avg = count ? valid.reduce((s, x) => s.plus(x), new D(0)).div(count) : null;
  const avgFields = avg ? { average: roundDisplay(avg), averageExact: exactStr(avg) } : { average: null, averageExact: null };
  if (!avg || count < required) return { ...base, ...avgFields, eligible: false, score: null, scoreExact: null };

  let score = avg.times(2);
  if (score.lt(0)) score = new D(0);
  if (score.gt(JOURNAL_RULES.SEMINAR_MAX)) score = new D(JOURNAL_RULES.SEMINAR_MAX);
  return { ...base, ...avgFields, eligible: true, score: roundDisplay(score), scoreExact: exactStr(score) };
}

export interface TotalResult {
  /** сумма имеющихся компонентов, 2 знака */
  score: number;
  exact: string;
  max: number;
  /** true только когда есть Final, Midterm и рассчитанный Seminar */
  final: boolean;
  provisional: boolean;
}

const clamp = (v: NumLike, max: number): Dec => {
  const d = new D(v);
  return d.lt(0) ? new D(0) : d.gt(max) ? new D(max) : d;
};

/**
 * TOTAL = FINAL + MIDTERM + SEMINAR.
 * Пока не хватает компонента (или seminar не eligible) — итог PROVISIONAL и равен сумме уже имеющихся компонентов.
 */
export function calculateTotal(
  finalScore: NumLike | null | undefined,
  midtermScore: NumLike | null | undefined,
  seminar: Pick<SeminarResult, 'eligible' | 'scoreExact'> | null | undefined,
): TotalResult {
  let sum = new D(0);
  let parts = 0;
  if (finalScore != null) { sum = sum.plus(clamp(finalScore, JOURNAL_RULES.FINAL_MAX)); parts++; }
  if (midtermScore != null) { sum = sum.plus(clamp(midtermScore, JOURNAL_RULES.MIDTERM_MAX)); parts++; }
  if (seminar?.eligible && seminar.scoreExact != null) { sum = sum.plus(clamp(seminar.scoreExact, JOURNAL_RULES.SEMINAR_MAX)); parts++; }
  const complete = parts === 3;
  return { score: roundDisplay(sum), exact: exactStr(sum), max: JOURNAL_RULES.TOTAL_MAX, final: complete, provisional: !complete };
}

/**
 * PROVISIONAL — не выполнены обязательные условия (нет Final/Midterm или < 3 ответов)
 * READY       — все компоненты есть, но не всё опубликовано
 * PUBLISHED   — всё опубликовано, период открыт
 * LOCKED      — всё опубликовано и период закрыт
 */
export function calculateJournalStatus(input: {
  hasFinal: boolean;
  hasMidterm: boolean;
  seminarEligible: boolean;
  allPublished: boolean;
  periodClosed: boolean;
}): JournalStatus {
  const complete = input.hasFinal && input.hasMidterm && input.seminarEligible;
  if (!complete) return 'PROVISIONAL';
  if (!input.allPublished) return 'READY';
  return input.periodClosed ? 'LOCKED' : 'PUBLISHED';
}

// ───────────────────────── Сводка по предмету из строк Grade ─────────────────────────

export interface GradeRowLike {
  id: string;
  type: string;
  value: NumLike;
  publishedAt: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
  teacherId?: string | null;
  comment?: string | null;
}

export interface ComponentView {
  id: string;
  score: number;
  max: number;
  published: boolean;
  updatedAt: string | null;
}
export interface SeminarAnswerView {
  id: string;
  score: number;
  max: number;
  published: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  comment: string | null;
}

export interface SubjectSummary {
  final: ComponentView | null;
  midterm: ComponentView | null;
  seminar: SeminarResult & { answers: SeminarAnswerView[] };
  total: TotalResult;
  complete: boolean;
  allPublished: boolean;
  status: JournalStatus;
  alerts: JournalAlertCode[];
  /** заработано / возможно по имеющимся компонентам — для «текущей успеваемости» в дашбордах */
  earned: number;
  possible: number;
  performancePct: number | null;
}

export interface SummarizeOptions {
  periodClosed?: boolean;
  lowTotal?: number;
}

const iso = (d?: Date | null) => (d ? d.toISOString() : null);
const latest = <T extends GradeRowLike>(rows: T[]): T | null =>
  rows.length ? rows.reduce((a, b) => ((b.updatedAt ?? b.createdAt ?? new Date(0)) > (a.updatedAt ?? a.createdAt ?? new Date(0)) ? b : a)) : null;

/** Строит полное состояние Journal по строкам Grade одного (student, subject, period). Legacy-типы игнорируются. */
export function summarizeSubject(rows: GradeRowLike[], opts: SummarizeOptions = {}): SubjectSummary {
  const finalRow = latest(rows.filter((r) => r.type === 'FINAL'));
  const midRow = latest(rows.filter((r) => r.type === 'MIDTERM'));
  const answerRows = rows
    .filter((r) => r.type === 'SEMINAR' && isValidAnswer(r.value))
    .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));

  const view = (r: GradeRowLike | null, max: number): ComponentView | null =>
    r ? { id: r.id, score: roundDisplay(clamp(r.value, max)), max, published: !!r.publishedAt, updatedAt: iso(r.updatedAt) } : null;

  const final = view(finalRow, JOURNAL_RULES.FINAL_MAX);
  const midterm = view(midRow, JOURNAL_RULES.MIDTERM_MAX);
  const seminarCalc = calculateSeminarScore(answerRows.map((r) => r.value));
  const answers: SeminarAnswerView[] = answerRows.map((r) => ({
    id: r.id,
    score: roundDisplay(r.value),
    max: JOURNAL_RULES.SEMINAR_ANSWER_MAX,
    published: !!r.publishedAt,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
    comment: r.comment ?? null,
  }));

  const total = calculateTotal(finalRow?.value, midRow?.value, seminarCalc);
  const counted = [finalRow, midRow, ...answerRows].filter(Boolean) as GradeRowLike[];
  const allPublished = counted.length > 0 && counted.every((r) => !!r.publishedAt);
  const anyDraft = counted.some((r) => !r.publishedAt);
  const complete = !!final && !!midterm && seminarCalc.eligible;
  const periodClosed = !!opts.periodClosed;
  const status = calculateJournalStatus({ hasFinal: !!final, hasMidterm: !!midterm, seminarEligible: seminarCalc.eligible, allPublished, periodClosed });

  const alerts: JournalAlertCode[] = [];
  if (!seminarCalc.eligible) alerts.push('SEMINAR_INCOMPLETE');
  if (!midterm) alerts.push('MISSING_MIDTERM');
  if (!final) alerts.push('MISSING_FINAL');
  if (!complete) alerts.push('PROVISIONAL');
  if (anyDraft) alerts.push('UNPUBLISHED');
  if (counted.some((r) => r.publishedAt && r.updatedAt && r.updatedAt.getTime() - r.publishedAt.getTime() > 60_000)) alerts.push('EDITED_AFTER_PUBLISH');
  if (complete && opts.lowTotal != null && new D(total.exact).lt(opts.lowTotal)) alerts.push('LOW_TOTAL');

  let earned = new D(0);
  let possible = 0;
  if (finalRow) { earned = earned.plus(clamp(finalRow.value, JOURNAL_RULES.FINAL_MAX)); possible += JOURNAL_RULES.FINAL_MAX; }
  if (midRow) { earned = earned.plus(clamp(midRow.value, JOURNAL_RULES.MIDTERM_MAX)); possible += JOURNAL_RULES.MIDTERM_MAX; }
  if (seminarCalc.eligible && seminarCalc.scoreExact) { earned = earned.plus(seminarCalc.scoreExact); possible += JOURNAL_RULES.SEMINAR_MAX; }

  return {
    final,
    midterm,
    seminar: { ...seminarCalc, answers },
    total,
    complete,
    allPublished,
    status,
    alerts,
    earned: roundDisplay(earned),
    possible,
    performancePct: possible > 0 ? roundDisplay(earned.div(possible).times(100)) : null,
  };
}

/**
 * Текущая успеваемость каждого студента по одному предмету в процентах (0..100) —
 * единый источник для дашбордов/рисков вместо усреднения «сырых» строк с разными шкалами.
 * null — по студенту ещё нет ни одного зачтённого компонента.
 */
export function performanceByStudent<T extends GradeRowLike & { studentId: string }>(rows: T[]): Map<string, number | null> {
  const by = new Map<string, T[]>();
  for (const r of rows) (by.get(r.studentId) ?? by.set(r.studentId, []).get(r.studentId)!).push(r);
  const out = new Map<string, number | null>();
  for (const [sid, rs] of by) out.set(sid, summarizeSubject(rs).performancePct);
  return out;
}

export type PeriodRow = GradeRowLike & { subjectId: string; academicYear: string; term: string; studentId?: string };

export interface GroupedRecord {
  studentId: string | null;
  subjectId: string;
  academicYear: string;
  term: string;
  summary: SubjectSummary;
}

/** Группирует строки Grade в записи Journal (студент × предмет × период) и считает каждую единой формулой. */
export function groupJournalRecords(rows: PeriodRow[], opts: SummarizeOptions = {}): GroupedRecord[] {
  const by = new Map<string, PeriodRow[]>();
  for (const r of rows) {
    if (!(JOURNAL_TYPES as readonly string[]).includes(r.type)) continue;
    const k = [r.studentId ?? '', r.subjectId, r.academicYear, r.term].join('|');
    (by.get(k) ?? by.set(k, []).get(k)!).push(r);
  }
  return Array.from(by.values()).map((rs) => ({
    studentId: rs[0].studentId ?? null,
    subjectId: rs[0].subjectId,
    academicYear: rs[0].academicYear,
    term: rs[0].term,
    summary: summarizeSubject(rs, opts),
  }));
}

/** Текущая успеваемость (%) по каждой записи Journal — для дашбордов и рисков (вместо среднего «сырых» строк с разными шкалами). */
export const recordPercents = (rows: PeriodRow[]): number[] =>
  groupJournalRecords(rows)
    .map((g) => g.summary.performancePct)
    .filter((x): x is number => x != null);

/** Только опубликованные строки: то, что видит студент. */
export const publishedOnly = <T extends { publishedAt: Date | null }>(rows: T[]): T[] => rows.filter((r) => !!r.publishedAt);

// ───────────────────────── Официальная шкала портала (100 → буква / GPA) ─────────────────────────
// Перенесено из students.service без изменений: единая mapping проекта.
// Университетская шкала: 91–100 A, 81–90 B, 71–80 C, 61–70 D, 51–60 E, ≤50 F (проходной балл 51)
export function toLetter(v: number): string {
  if (v >= 91) return 'A';
  if (v >= 81) return 'B';
  if (v >= 71) return 'C';
  if (v >= 61) return 'D';
  if (v >= 51) return 'E';
  return 'F';
}

export function toGradePoints(v: number): number {
  if (v >= 90) return 4.0;
  if (v >= 85) return 3.7;
  if (v >= 80) return 3.3;
  if (v >= 75) return 3.0;
  if (v >= 70) return 2.7;
  if (v >= 65) return 2.3;
  if (v >= 60) return 2.0;
  if (v >= 51) return 1.0;
  return 0.0;
}
