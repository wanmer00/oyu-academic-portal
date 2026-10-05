import { describe, expect, it } from 'vitest';
import { checkWindow, defaultResitWindow, ipInNetworks, launchToken, letterFor, localParts, nextAllowedDate, questionHash, resitFee, safeEqual, scoreExam, shuffle, weekRange } from './exam.rules';

const answers = (c: number, w: number, s: number) => [...Array(c).fill('CORRECT'), ...Array(w).fill('WRONG'), ...Array(s).fill('SKIP')] as Array<'CORRECT' | 'WRONG' | 'SKIP'>;

describe('scoreExam', () => {
  it('+2 / -1 / 0, max 50, min -25', () => {
    expect(scoreExam({ answers: answers(25, 0, 0), entryScore: 0 }).examScore).toBe(50);
    expect(scoreExam({ answers: answers(0, 25, 0), entryScore: 0 }).examScore).toBe(-25);
    expect(scoreExam({ answers: answers(0, 0, 25), entryScore: 0 }).examScore).toBe(0);
  });
  it('example: entry 30 + exam 21 = 51 → PASS', () => {
    // 12 верных, 3 неверных = 21
    const r = scoreExam({ answers: answers(12, 3, 10), entryScore: 30 });
    expect(r.examScore).toBe(21);
    expect(r.total).toBe(51);
    expect(r.passed).toBe(true);
    expect(r.letter).toBe('E');
  });
  it('example: entry 50 + exam 10 = 60 but exam < 17 → FAIL, letter E', () => {
    const r = scoreExam({ answers: answers(6, 2, 17), entryScore: 50 }); // 12-2 = 10
    expect(r.examScore).toBe(10);
    expect(r.total).toBe(60);
    expect(r.letter).toBe('E');
    expect(r.passed).toBe(false);
    expect(r.failReason).toBe('MIN_EXAM_SCORE');
  });
  it('exam 16 fails, exam 17 passes at high entry', () => {
    expect(scoreExam({ answers: answers(8, 0, 17), entryScore: 50 }).passed).toBe(false); // 16
    expect(scoreExam({ answers: answers(9, 1, 15), entryScore: 50 }).passed).toBe(true); // 17
  });
  it('total below 51 fails even with exam >= 17', () => {
    const r = scoreExam({ answers: answers(9, 1, 15), entryScore: 33 }); // 17 + 33 = 50
    expect(r.total).toBe(50);
    expect(r.passed).toBe(false);
    expect(r.failReason).toBe('TOTAL_BELOW_PASS');
    expect(r.letter).toBe('F');
  });
  it('both conditions failing → BOTH', () => {
    expect(scoreExam({ answers: answers(1, 5, 19), entryScore: 20 }).failReason).toBe('BOTH');
  });
  it('fractional entry score keeps decimals', () => {
    const r = scoreExam({ answers: answers(10, 0, 15), entryScore: '30.5' }); // exam 20
    expect(r.total).toBe(50.5);
    expect(r.passed).toBe(false);
  });
});

describe('letterFor', () => {
  it.each([[100, 'A'], [91, 'A'], [90, 'B'], [81, 'B'], [80, 'C'], [71, 'C'], [70, 'D'], [61, 'D'], [60, 'E'], [51, 'E'], [50, 'F'], [0, 'F']])('%s → %s', (v, l) => expect(letterFor(v)).toBe(l));
});

describe('resitFee', () => {
  it.each([[4, 15], [8, 30], [12, 45]])('%s credits → %s AZN', (c, fee) => expect(resitFee(c, 15, 0.25).fee).toBe(fee));
  it('full cost and decimals (3.75 per credit)', () => {
    expect(resitFee(12, 15).full).toBe(180);
    expect(resitFee(3, 15).fee).toBe(11.25);
  });
});

describe('checkWindow', () => {
  // 10:00–12:00 Пн/Ср/Пт, июнь 2027 (Asia/Baku = UTC+4)
  const w = { status: 'PUBLISHED', startDate: new Date('2027-06-01T00:00:00Z'), endDate: new Date('2027-06-30T00:00:00Z'), allowedWeekdays: [1, 3, 5], startTime: '10:00', endTime: '12:00' };
  const at = (iso: string) => new Date(iso + '+04:00');
  it('11:59 is allowed, 12:00 is not', () => {
    expect(checkWindow(w, at('2027-06-02T11:59:00'))).toBeNull(); // среда
    expect(checkWindow(w, at('2027-06-02T12:00:00'))).toBe('OUTSIDE_ALLOWED_TIME');
    expect(checkWindow(w, at('2027-06-02T09:59:59'))).toBe('OUTSIDE_ALLOWED_TIME');
    expect(checkWindow(w, at('2027-06-02T10:00:00'))).toBeNull();
  });
  it('weekday and dates', () => {
    expect(checkWindow(w, at('2027-06-03T11:00:00'))).toBe('WEEKDAY_NOT_ALLOWED'); // четверг
    expect(checkWindow(w, at('2027-05-31T11:00:00'))).toBe('WINDOW_NOT_STARTED');
    expect(checkWindow(w, at('2027-07-01T11:00:00'))).toBe('WINDOW_CLOSED');
    expect(checkWindow({ ...w, status: 'DRAFT' }, at('2027-06-02T11:00:00'))).toBe('WINDOW_NOT_PUBLISHED');
  });
  it('timezone: 23:30 UTC is already next day in Baku', () => {
    expect(localParts(new Date('2027-06-01T23:30:00Z')).date).toBe('2027-06-02');
  });
  it('nextAllowedDate skips disallowed days', () => {
    expect(nextAllowedDate(w, at('2027-06-02T13:00:00'))).toBe('2027-06-02');
    expect(nextAllowedDate(w, at('2027-06-03T09:00:00'))).toBe('2027-06-04');
  });
});

describe('weekRange / resit window', () => {
  it('week is Monday 00:00 Baku → next Monday', () => {
    const { from, to } = weekRange(new Date('2027-06-02T10:00:00+04:00'));
    expect(from.toISOString()).toBe('2027-05-30T20:00:00.000Z'); // пн 31.05 00:00 Baku
    expect(to.getTime() - from.getTime()).toBe(7 * 86400000);
  });
  it('resit window starts exactly one week after final window end, Mon–Fri', () => {
    const r = defaultResitWindow({ startDate: new Date('2027-06-01'), endDate: new Date('2027-06-30'), startTime: '10:00', endTime: '12:00' });
    expect(r.startDate).toBe('2027-07-07');
    expect(r.allowedWeekdays).toEqual([1, 2, 3, 4, 5]);
    expect(r.startTime).toBe('10:00');
  });
});

describe('security helpers', () => {
  it('launch token is bound to every field', () => {
    const a = { id: 'a1', workstationId: 'w1', studentId: 's1', examId: 'e1', expiresAt: new Date(1000) };
    const t = launchToken('secret', a);
    expect(safeEqual(t, launchToken('secret', a))).toBe(true);
    for (const k of ['id', 'workstationId', 'studentId', 'examId'] as const) expect(safeEqual(t, launchToken('secret', { ...a, [k]: 'x' }))).toBe(false);
    expect(safeEqual(t, launchToken('other', a))).toBe(false);
  });
  it('shuffle keeps elements; duplicates detected by hash', () => {
    const arr = Array.from({ length: 50 }, (_, i) => i);
    expect([...shuffle(arr)].sort((a, b) => a - b)).toEqual(arr);
    expect(questionHash('2+2?', ['3', '4'])).toBe(questionHash('  2+2? ', ['4', '3']));
    expect(questionHash('2+2?', ['3', '4'])).not.toBe(questionHash('2+3?', ['3', '4']));
  });
  it('ipInNetworks handles CIDR, mapped IPv4 and empty', () => {
    expect(ipInNetworks('10.1.2.3', ['10.1.0.0/16'])).toBe(true);
    expect(ipInNetworks('::ffff:10.1.2.3', ['10.1.0.0/16'])).toBe(true);
    expect(ipInNetworks('10.2.2.3', ['10.1.0.0/16'])).toBe(false);
    expect(ipInNetworks(undefined, ['10.1.0.0/16'])).toBe(false);
    expect(ipInNetworks('203.0.113.9', [])).toBe(false);
  });
});
