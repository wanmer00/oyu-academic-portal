import { describe, expect, it } from 'vitest';
import {
  calculateJournalStatus,
  calculateSeminarScore,
  calculateTotal,
  JOURNAL_RULES,
  publishedOnly,
  roundDisplay,
  summarizeSubject,
  toGradePoints,
  toLetter,
  GradeRowLike,
} from './journal.calc';

const T0 = new Date('2026-05-01T10:00:00Z');
let n = 0;
const row = (type: string, value: number, published = true, extra: Partial<GradeRowLike> = {}): GradeRowLike => ({
  id: 'g' + ++n,
  type,
  value,
  publishedAt: published ? T0 : null,
  createdAt: new Date(T0.getTime() + n * 1000),
  updatedAt: new Date(T0.getTime() + n * 1000),
  ...extra,
});

describe('calculateSeminarScore — average(all valid answers) × 2, min 3 answers', () => {
  it('case 1: 6,7,8 → 14', () => {
    const r = calculateSeminarScore([6, 7, 8]);
    expect(r.eligible).toBe(true);
    expect(r.average).toBe(7);
    expect(r.score).toBe(14);
  });
  it('case 2: 9,9,9,9 → 18', () => {
    expect(calculateSeminarScore([9, 9, 9, 9]).score).toBe(18);
  });
  it('case 3: 6,7,8,9 → 15 (uses all 4 answers, not only 3)', () => {
    const r = calculateSeminarScore([6, 7, 8, 9]);
    expect(r.average).toBe(7.5);
    expect(r.score).toBe(15);
  });
  it('case 4: 2 answers → Pending / not eligible (no fake score)', () => {
    const r = calculateSeminarScore([9, 10]);
    expect(r.eligible).toBe(false);
    expect(r.score).toBeNull();
    expect(r.scoreExact).toBeNull();
    expect(r.count).toBe(2);
    expect(r.required).toBe(3);
    expect(r.missing).toBe(1);
  });
  it('0, 1 answers → not eligible', () => {
    expect(calculateSeminarScore([]).eligible).toBe(false);
    expect(calculateSeminarScore([]).missing).toBe(3);
    const one = calculateSeminarScore([10]);
    expect(one.eligible).toBe(false);
    expect(one.score).toBeNull();
  });
  it('case 5: 0,0,0 → 0 and eligible (zero is a valid score)', () => {
    const r = calculateSeminarScore([0, 0, 0]);
    expect(r.eligible).toBe(true);
    expect(r.score).toBe(0);
  });
  it('case 6: 10,10,10 → 20', () => {
    expect(calculateSeminarScore([10, 10, 10]).score).toBe(20);
  });
  it('5 and 10 answers use all of them', () => {
    expect(calculateSeminarScore([8, 8, 8, 8, 8]).score).toBe(16);
    expect(calculateSeminarScore([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).score).toBe(11); // avg 5.5 × 2
  });
  it('decimal average keeps precision: 8,9,8 → 16.666… shown as 16.67, exact kept', () => {
    const r = calculateSeminarScore([8, 9, 8]);
    expect(r.score).toBe(16.67);
    expect(r.scoreExact!.startsWith('16.6666666')).toBe(true);
    expect(r.average).toBe(8.33);
  });
  it('8,9,7 → exactly 16', () => {
    expect(calculateSeminarScore([8, 9, 7]).score).toBe(16);
  });
  it('accepts decimal answers (7.5, 8.25, 9)', () => {
    expect(calculateSeminarScore([7.5, 8.25, 9]).scoreExact).toBe('16.5');
  });
  it('never exceeds 20 and never below 0', () => {
    const r = calculateSeminarScore([10, 10, 10, 10]);
    expect(r.score).toBe(20);
    expect(r.score!).toBeLessThanOrEqual(20);
    expect(r.score!).toBeGreaterThanOrEqual(0);
  });
  it('invalid answers (-1, 11, 100, NaN) are ignored, not counted', () => {
    const r = calculateSeminarScore([6, 7, 8, -1, 11, 100, NaN]);
    expect(r.count).toBe(3);
    expect(r.invalidIgnored).toBe(4);
    expect(r.score).toBe(14);
    const bad = calculateSeminarScore([-1, 11, 100]);
    expect(bad.count).toBe(0);
    expect(bad.eligible).toBe(false);
  });
});

describe('calculateTotal — final + midterm + seminar', () => {
  const sem = (a: number[]) => calculateSeminarScore(a);
  it('case 7: 43 + 26 + 16 = 85', () => {
    const t = calculateTotal(43, 26, sem([8, 8, 8]));
    expect(t.score).toBe(85);
    expect(t.final).toBe(true);
    expect(t.provisional).toBe(false);
    expect(t.max).toBe(100);
  });
  it('case 8: 50 + 30 + 20 = 100', () => {
    expect(calculateTotal(50, 30, sem([10, 10, 10])).score).toBe(100);
  });
  it('case 9: 0 + 0 + 0 = 0 and it is complete', () => {
    const t = calculateTotal(0, 0, sem([0, 0, 0]));
    expect(t.score).toBe(0);
    expect(t.final).toBe(true);
  });
  it('seminar pending → provisional, seminar not added', () => {
    const t = calculateTotal(43, 26, sem([8, 8]));
    expect(t.provisional).toBe(true);
    expect(t.final).toBe(false);
    expect(t.score).toBe(69);
  });
  it('missing final or midterm → provisional', () => {
    expect(calculateTotal(null, 26, sem([8, 8, 8])).provisional).toBe(true);
    expect(calculateTotal(43, undefined, sem([8, 8, 8])).provisional).toBe(true);
    expect(calculateTotal(null, null, null).score).toBe(0);
  });
  it('clamps out-of-range components defensively', () => {
    expect(calculateTotal(80, 45, sem([10, 10, 10])).score).toBe(100);
    expect(calculateTotal(-5, 0, sem([0, 0, 0])).score).toBe(0);
  });
  it('sample from spec: 6,7,8 + 26 + 43 = 83', () => {
    expect(calculateTotal(43, 26, sem([6, 7, 8])).score).toBe(83);
  });
  it('keeps decimals: 43 + 26 + 16.666… = 85.67', () => {
    const t = calculateTotal(43, 26, sem([8, 9, 8]));
    expect(t.score).toBe(85.67);
    expect(t.exact.startsWith('85.6666666')).toBe(true);
  });
});

describe('calculateJournalStatus', () => {
  const base = { hasFinal: true, hasMidterm: true, seminarEligible: true, allPublished: true, periodClosed: false };
  it('provisional when a mandatory component is missing', () => {
    expect(calculateJournalStatus({ ...base, seminarEligible: false })).toBe('PROVISIONAL');
    expect(calculateJournalStatus({ ...base, hasFinal: false })).toBe('PROVISIONAL');
    expect(calculateJournalStatus({ ...base, hasMidterm: false })).toBe('PROVISIONAL');
  });
  it('ready when complete but not published', () => {
    expect(calculateJournalStatus({ ...base, allPublished: false })).toBe('READY');
  });
  it('published / locked', () => {
    expect(calculateJournalStatus(base)).toBe('PUBLISHED');
    expect(calculateJournalStatus({ ...base, periodClosed: true })).toBe('LOCKED');
  });
  it('closed period with incomplete record is still provisional (no contradictory status)', () => {
    expect(calculateJournalStatus({ ...base, seminarEligible: false, periodClosed: true })).toBe('PROVISIONAL');
  });
});

describe('summarizeSubject', () => {
  it('Student A: 6,7,8 + midterm 26 + final 43 → seminar 14, total 83, PUBLISHED', () => {
    const s = summarizeSubject([row('SEMINAR', 6), row('SEMINAR', 7), row('SEMINAR', 8), row('MIDTERM', 26), row('FINAL', 43)]);
    expect(s.seminar.score).toBe(14);
    expect(s.total.score).toBe(83);
    expect(s.status).toBe('PUBLISHED');
    expect(s.complete).toBe(true);
    expect(s.alerts).toEqual([]);
  });
  it('Student B: 9,9,9,9 → 18', () => {
    const s = summarizeSubject([9, 9, 9, 9].map((v) => row('SEMINAR', v)));
    expect(s.seminar.score).toBe(18);
  });
  it('Student C: 2 answers → pending, provisional, alerts', () => {
    const s = summarizeSubject([row('SEMINAR', 9), row('SEMINAR', 8), row('MIDTERM', 22), row('FINAL', 41)]);
    expect(s.seminar.eligible).toBe(false);
    expect(s.seminar.score).toBeNull();
    expect(s.total.provisional).toBe(true);
    expect(s.status).toBe('PROVISIONAL');
    expect(s.alerts).toContain('SEMINAR_INCOMPLETE');
    expect(s.alerts).toContain('PROVISIONAL');
  });
  it('drafts make a complete record READY, published-only view stays provisional', () => {
    const rows = [row('SEMINAR', 8, false), row('SEMINAR', 8, false), row('SEMINAR', 8, false), row('MIDTERM', 25, false), row('FINAL', 40, false)];
    expect(summarizeSubject(rows).status).toBe('READY');
    expect(summarizeSubject(publishedOnly(rows)).status).toBe('PROVISIONAL');
  });
  it('period lock only affects fully published complete records', () => {
    const rows = [row('SEMINAR', 8), row('SEMINAR', 8), row('SEMINAR', 8), row('MIDTERM', 25), row('FINAL', 40)];
    expect(summarizeSubject(rows, { periodClosed: true }).status).toBe('LOCKED');
  });
  it('legacy types (HOMEWORK/QUIZ/PROJECT) do not enter the formula', () => {
    const s = summarizeSubject([row('HOMEWORK', 9), row('PROJECT', 50), row('QUIZ', 90), row('MIDTERM', 20)]);
    expect(s.seminar.count).toBe(0);
    expect(s.total.score).toBe(20);
  });
  it('low total alert uses configurable threshold', () => {
    const rows = [row('SEMINAR', 2), row('SEMINAR', 2), row('SEMINAR', 2), row('MIDTERM', 10), row('FINAL', 20)];
    expect(summarizeSubject(rows, { lowTotal: 60 }).alerts).toContain('LOW_TOTAL');
    expect(summarizeSubject(rows, { lowTotal: 30 }).alerts).not.toContain('LOW_TOTAL');
  });
  it('edited after publish alert', () => {
    const changed = row('MIDTERM', 25, true, { updatedAt: new Date(T0.getTime() + 3_600_000) });
    expect(summarizeSubject([changed]).alerts).toContain('EDITED_AFTER_PUBLISH');
  });
  it('performancePct counts only available components', () => {
    const s = summarizeSubject([row('MIDTERM', 15), row('FINAL', 25)]);
    expect(s.earned).toBe(40);
    expect(s.possible).toBe(80);
    expect(s.performancePct).toBe(50);
    expect(summarizeSubject([]).performancePct).toBeNull();
  });
});

describe('rules & official mapping', () => {
  it('scales add up to 100', () => {
    expect(JOURNAL_RULES.FINAL_MAX + JOURNAL_RULES.MIDTERM_MAX + JOURNAL_RULES.SEMINAR_MAX).toBe(JOURNAL_RULES.TOTAL_MAX);
    expect(JOURNAL_RULES.SEMINAR_MIN_ANSWERS).toBe(3);
  });
  it('existing letter / GPA mapping is preserved', () => {
    expect(toLetter(95)).toBe('A');
    expect(toLetter(91)).toBe('A');
    expect(toLetter(90)).toBe('B');
    expect(toLetter(60)).toBe('E');
    expect(toLetter(51)).toBe('E');
    expect(toLetter(50.99)).toBe('F');
    expect(toGradePoints(85)).toBe(3.7);
    expect(toGradePoints(60)).toBe(2);
    expect(toGradePoints(59)).toBe(1);
    expect(toGradePoints(50)).toBe(0);
  });
  it('display rounding is half-up with 2 decimals', () => {
    expect(roundDisplay(16.666666)).toBe(16.67);
    expect(roundDisplay(7.005)).toBe(7.01);
  });
});
