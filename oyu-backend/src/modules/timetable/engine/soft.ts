import { Weights } from './types';

/**
 * Формулы мягких ограничений — ЕДИНЫЕ для солвера (инкрементальная оценка) и Conflict Checker (отчёт о нарушениях).
 * Все функции чистые и работают с «элементами дня» (занятия одной сущности в один день).
 */
export interface DayItem {
  /** позиция пары в общей сетке (0..n), -1 — вне сетки */
  rank: number;
  /** порядковый номер пары в сетке уровня (0-based), -1 — вне сетки */
  levelOrder: number;
  building: string | null;
}

export interface DayMetrics {
  lessons: number;
  /** окон между парами (пропущенных пар между первой и последней) */
  gaps: number;
  /** самая длинная цепочка пар подряд */
  maxRun: number;
  /** протяжённость дня в парах (от первой до последней) */
  span: number;
  /** смен корпуса между соседними парами */
  moves: number;
  /** пар с порядковым номером >= lateFrom */
  late: number;
}

export const LATE_FROM = 3;

const byRank = (a: DayItem, b: DayItem) => a.rank - b.rank;

export function dayMetrics(items: DayItem[]): DayMetrics {
  const n = items.length;
  if (!n) return { lessons: 0, gaps: 0, maxRun: 0, span: 0, moves: 0, late: 0 };
  const sorted = items.length > 1 ? items.slice().sort(byRank) : items;
  let gaps = 0, run = 1, maxRun = 1, moves = 0, late = 0;
  let firstRank = -1, lastRank = -1;
  for (let i = 0; i < sorted.length; i++) {
    const it = sorted[i];
    if (it.levelOrder >= LATE_FROM) late++;
    if (it.rank >= 0) {
      if (firstRank < 0) firstRank = it.rank;
      lastRank = it.rank;
    }
    if (i === 0) continue;
    const prev = sorted[i - 1];
    if (it.rank < 0 || prev.rank < 0) continue;
    const diff = it.rank - prev.rank;
    if (diff <= 0) continue; // одна и та же пара (разная чётность недели)
    if (diff === 1) {
      run++;
      if (run > maxRun) maxRun = run;
      if (it.building && prev.building && it.building !== prev.building) moves++;
    } else {
      gaps += diff - 1;
      run = 1;
      // переход между корпусами через окно не штрафуется — время на дорогу есть
    }
  }
  return { lessons: n, gaps, maxRun, span: firstRank >= 0 ? lastRank - firstRank + 1 : 0, moves, late };
}

export interface GroupDayCost {
  gap: number;
  consecutive: number;
  overload: number;
  longDay: number;
  building: number;
  late: number;
  total: number;
}

export function groupDayCost(m: DayMetrics, w: Weights, maxConsecutive: number, maxDaily: number, longDayLimit: number): GroupDayCost {
  const gap = w.gap * m.gaps;
  const consecutive = w.consecutive * Math.max(0, m.maxRun - maxConsecutive);
  const overload = w.overload * Math.max(0, m.lessons - maxDaily);
  const longDay = w.longDay * Math.max(0, m.span - longDayLimit);
  const building = w.building * m.moves;
  const late = w.late * m.late;
  return { gap, consecutive, overload, longDay, building, late, total: gap + consecutive + overload + longDay + building + late };
}

export function teacherDayCost(m: DayMetrics, w: Weights): { gap: number; building: number; total: number } {
  const gap = w.teacherGap * m.gaps;
  const building = w.building * m.moves;
  return { gap, building, total: gap + building };
}

/** Неравномерность недельной нагрузки: сумма квадратов отклонений от среднего по рабочим дням */
export function balanceCost(counts: ArrayLike<number>, workingDays: number[], w: Weights): number {
  let total = 0;
  for (const d of workingDays) total += counts[d - 1] || 0;
  if (!total) return 0;
  const mean = total / workingDays.length;
  let s = 0;
  for (const d of workingDays) { const x = (counts[d - 1] || 0) - mean; s += x * x; }
  return w.balance * s;
}

/** Разнесение занятий одной нагрузки по дням: штраф за один день и за соседние дни подряд */
export function spacingCost(days: number[], w: Weights): { sameDay: number; adjacent: number; total: number } {
  if (days.length < 2) return { sameDay: 0, adjacent: 0, total: 0 };
  const set = new Set(days);
  const dup = days.length - set.size;
  const ds = Array.from(set).sort((a, b) => a - b);
  let adj = 0;
  for (let i = 1; i < ds.length; i++) if (ds[i] - ds[i - 1] === 1) adj++;
  const sameDay = w.sameDay * dup;
  const adjacent = w.adjacent * adj;
  return { sameDay, adjacent, total: sameDay + adjacent };
}

export const roomFitCost = (capacity: number, need: number, w: Weights): number =>
  capacity > 0 && need > 0 ? w.roomFit * Math.max(0, (capacity - need) / capacity) * 10 : 0;
