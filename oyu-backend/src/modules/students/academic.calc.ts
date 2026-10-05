import { toGradePoints, toLetter } from '../journal/journal.calc';

/**
 * Официальный академический расчёт студента — единственный источник GPA / кредитов / статуса.
 * Используется транскриптом и /me/academic-summary; frontend ничего не пересчитывает.
 */

/** Проходной балл университетской шкалы (51–60 = E) */
export const PASS_MARK = 51;

export type AcademicStanding = 'NONE' | 'EXCELLENT' | 'GOOD' | 'SATISFACTORY' | 'AT_RISK';

export interface SubjectOutcome {
  passed: boolean;
  letter: string;
  gradePoints: number;
}

/** Итог завершённого предмета по сумме журнала (0..100). Несданный: F, 0 баллов GPA, кредиты не засчитываются. */
export function subjectOutcome(total: number): SubjectOutcome {
  const passed = total >= PASS_MARK;
  return passed ? { passed, letter: toLetter(total), gradePoints: toGradePoints(total) } : { passed, letter: 'F', gradePoints: 0 };
}

/** GPA, взвешенный по кредитам (2 знака). Нет завершённых предметов → null (нет данных), а не 0 */
export function weightedGpa(rows: Array<{ credits: number; gradePoints: number }>): number | null {
  const credits = rows.reduce((s, r) => s + r.credits, 0);
  if (!credits) return null;
  return Math.round((rows.reduce((s, r) => s + r.gradePoints * r.credits, 0) / credits) * 100) / 100;
}

export function standingFor(gpa: number | null): AcademicStanding {
  if (gpa == null) return 'NONE';
  if (gpa >= 3.5) return 'EXCELLENT';
  if (gpa >= 2.5) return 'GOOD';
  if (gpa >= 2.0) return 'SATISFACTORY';
  return 'AT_RISK';
}
