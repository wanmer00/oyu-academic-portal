import { describe, expect, it } from 'vitest';
import { addStatus, attendanceRate, countedAbsences, emptyCounts, limitOf, maxAbsencesForCredits, parseClassDay } from './attendance.calc';

describe('attendance.calc — единые правила посещаемости', () => {
  it('лимит пропусков: 2 на кредит, минимум 2', () => {
    expect(maxAbsencesForCredits(3)).toBe(6);
    expect(maxAbsencesForCredits(6)).toBe(12);
    expect(maxAbsencesForCredits(1)).toBe(2);
    expect(maxAbsencesForCredits(0)).toBe(2);
  });

  it('в лимит идут ABSENT + floor(LATE/2); EXCUSED не засчитывается', () => {
    expect(countedAbsences({ ABSENT: 2, LATE: 3 })).toBe(3);
    expect(countedAbsences({ ABSENT: 0, LATE: 1 })).toBe(0);
    const c = emptyCounts();
    addStatus(c, 'EXCUSED', 5);
    expect(countedAbsences(c)).toBe(0);
  });

  it('процент посещаемости = (занятий − ABSENT) / занятий; null без занятий', () => {
    expect(attendanceRate({ total: 0, ABSENT: 0 })).toBeNull();
    expect(attendanceRate({ total: 10, ABSENT: 2 })).toBe(80);
    expect(attendanceRate({ total: 3, ABSENT: 1 })).toBe(67);
  });

  it('limitOf: статусы OK / WARNING / CRITICAL / EXCEEDED (5 кредитов → лимит 10)', () => {
    const at = (absent: number) => limitOf({ ...emptyCounts(), ABSENT: absent, total: 30 }, 5);
    expect(at(6).status).toBe('OK');
    expect(at(7).status).toBe('WARNING');
    expect(at(9).status).toBe('CRITICAL');
    expect(at(10).status).toBe('EXCEEDED');
    expect(at(10).exceeded).toBe(true);
    expect(at(4).remaining).toBe(6);
  });
  it('parseClassDay: сутки UTC, мусор → null', () => {
    expect(parseClassDay('2026-07-06T15:30:00.000Z')?.toISOString()).toBe('2026-07-06T00:00:00.000Z');
    expect(parseClassDay('garbage')).toBeNull();
  });
});
