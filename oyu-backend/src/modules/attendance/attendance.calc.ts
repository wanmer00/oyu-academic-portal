import { AttendanceStatus } from '@prisma/client';

/**
 * Единственное место, где определены правила посещаемости (Academic Journal → Attendance).
 *  - лимит пропусков: 2 на кредит (минимум 2);
 *  - в лимит идут ABSENT + floor(LATE / 2); EXCUSED не засчитывается;
 *  - процент посещаемости = (занятий − ABSENT) / занятий.
 */
export interface Counts {
  PRESENT: number;
  LATE: number;
  ABSENT: number;
  EXCUSED: number;
  total: number;
}

export type LimitStatus = 'OK' | 'WARNING' | 'CRITICAL' | 'EXCEEDED';

export const emptyCounts = (): Counts => ({ PRESENT: 0, LATE: 0, ABSENT: 0, EXCUSED: 0, total: 0 });

export function addStatus(c: Counts, status: AttendanceStatus, n = 1): Counts {
  c[status] += n;
  c.total += n;
  return c;
}

export const maxAbsencesForCredits = (credits: number): number => Math.max(2, credits * 2);

export const countedAbsences = (c: Pick<Counts, 'ABSENT' | 'LATE'>): number => c.ABSENT + Math.floor(c.LATE / 2);

export const attendanceRate = (c: Pick<Counts, 'total' | 'ABSENT'>): number | null =>
  c.total ? Math.round(((c.total - c.ABSENT) / c.total) * 100) : null;

export function limitOf(c: Counts, credits: number) {
  const max = maxAbsencesForCredits(credits);
  const counted = countedAbsences(c);
  const percentage = max > 0 ? Math.round((counted / max) * 100) : 0;
  const status: LimitStatus = counted >= max ? 'EXCEEDED' : percentage >= 90 ? 'CRITICAL' : percentage >= 70 ? 'WARNING' : 'OK';
  return { max, counted, remaining: Math.max(0, max - counted), percentage, status, exceeded: counted >= max };
}

/** Календарный день занятия в UTC (00:00:00.000Z) или null */
export function parseClassDay(iso: string): Date | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export const dayKey = (d: Date) => d.toISOString().slice(0, 10);
