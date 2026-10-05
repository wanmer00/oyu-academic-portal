/**
 * Scheduling Engine — чистые типы задачи. Никакой зависимости от Prisma/Nest: движок работает в worker thread
 * и покрывается unit-тестами на синтетических данных университетского масштаба.
 */
export type Level = 'BACHELOR' | 'MASTER' | 'PHD';
/** Маска чётности недели: 1 = верхняя, 2 = нижняя, 3 = каждая неделя */
export type ParityMask = 1 | 2 | 3;

export const PARITY_BITS: Record<string, ParityMask> = { UPPER: 1, LOWER: 2, BOTH: 3 };
export const PARITY_NAMES: Record<number, 'UPPER' | 'LOWER' | 'BOTH'> = { 1: 'UPPER', 2: 'LOWER', 3: 'BOTH' };

export interface PSlot {
  id: string;
  code: string;
  /** минуты от полуночи */
  start: number;
  end: number;
  level: Level | null;
  /** метка смены: пары разной смены не склеиваются в «сдвоенное» занятие */
  shift: string | null;
  order: number;
}

export interface PRoom {
  id: string;
  code: string;
  building: string | null;
  capacity: number;
  type: string;
  features: string[];
}

export interface PTeacher {
  id: string;
  name: string;
}

export interface PGroup {
  name: string;
  size: number;
  level: Level;
}

export type RuleScope = 'GLOBAL' | 'TEACHER' | 'GROUP' | 'ROOM' | 'BUILDING' | 'SUBJECT';
export type RuleKind = 'UNAVAILABLE' | 'PREFERRED' | 'NO_LATE' | 'MAX_PER_DAY' | 'ALLOWED_BUILDINGS';

export interface PRule {
  id?: string;
  scope: RuleScope;
  /** teacherId / groupName / roomId / buildingName / subjectId; null для GLOBAL */
  target: string | null;
  kind: RuleKind;
  hard: boolean;
  /** пусто = все рабочие дни */
  days: number[];
  /** коды пар (TimeSlot.code); пусто = все пары */
  slotCodes: string[];
  /** MAX_PER_DAY: {max}; NO_LATE: {maxOrder}; ALLOWED_BUILDINGS: {buildings: string[]} */
  value: any;
  weight: number;
}

/** Занятие, которое нужно разместить */
export interface PSession {
  id: string;
  requirementId: string;
  index: number;
  subjectId: string;
  teacherId: string | null;
  groups: string[];
  type: string;
  /** допустимые типы аудиторий; пусто = любые */
  roomTypes: string[];
  features: string[];
  parity: ParityMask;
  /** сколько подряд идущих пар занимает */
  duration: number;
  level: Level;
  /** false — занятие без аудитории (онлайн, консультация) */
  needsRoom?: boolean;
}

/** Уже размещённое занятие (зафиксированное или вне области перегенерации): занимает ресурсы, но не двигается */
export interface PFixed {
  id: string;
  requirementId?: string | null;
  subjectId: string;
  teacherId: string | null;
  roomId: string | null;
  groups: string[];
  day: number;
  start: number;
  end: number;
  parity: ParityMask;
}

export interface Weights {
  /** окно между парами у группы */
  gap: number;
  /** окно между парами у преподавателя */
  teacherGap: number;
  /** подряд больше допустимого */
  consecutive: number;
  /** занятий в день больше допустимого */
  overload: number;
  /** слишком длинный учебный день группы */
  longDay: number;
  /** переходы между корпусами в соседних парах */
  building: number;
  /** поздние пары (начиная с 4-й в сетке уровня) */
  late: number;
  /** неравномерность недельной нагрузки группы */
  balance: number;
  /** два занятия одной нагрузки в один день */
  sameDay: number;
  /** одна нагрузка в соседние дни подряд */
  adjacent: number;
  /** лишняя вместимость аудитории */
  roomFit: number;
  /** множитель для нежелательных времён (мягкое UNAVAILABLE) */
  avoid: number;
  /** множитель бонуса за PREFERRED */
  prefer: number;
}

export const DEFAULT_WEIGHTS: Weights = {
  gap: 6, teacherGap: 3, consecutive: 8, overload: 10, longDay: 3, building: 5, late: 2, balance: 1.5, sameDay: 7, adjacent: 2, roomFit: 1, avoid: 5, prefer: 2,
};

export interface SolverParams {
  seed: number;
  timeLimitMs: number;
  /** максимум итераций оптимизации (0 — только по времени) */
  maxIterations: number;
  maxConsecutive: number;
  maxDaily: number;
  longDayLimit: number;
}

export interface Problem {
  days: number[];
  slots: PSlot[];
  rooms: PRoom[];
  teachers: PTeacher[];
  groups: PGroup[];
  rules: PRule[];
  sessions: PSession[];
  fixed: PFixed[];
  weights: Weights;
  params: SolverParams;
}

export interface Assignment {
  sessionId: string;
  day: number;
  slotId: string;
  /** слоты, занимаемые занятием (по порядку) */
  slotIds: string[];
  start: number;
  end: number;
  roomId: string | null;
}

export type UnplacedCode =
  | 'NO_ROOM_FITS'
  | 'NO_SLOT_FOR_LEVEL'
  | 'TEACHER_UNAVAILABLE'
  | 'TEACHER_BUSY'
  | 'GROUP_UNAVAILABLE'
  | 'GROUP_BUSY'
  | 'ROOMS_BUSY'
  | 'DAY_LIMIT'
  | 'NO_WORKING_DAYS';

export interface Unplaced {
  sessionId: string;
  code: UnplacedCode;
  /** сколько позиций отвергнуто по каждой причине (для диагностики) */
  tally: Partial<Record<UnplacedCode, number>>;
}

export interface SolveResult {
  assignments: Assignment[];
  unplaced: Unplaced[];
  cost: number;
  breakdown: Record<string, number>;
  iterations: number;
  elapsedMs: number;
  phases: Array<{ phase: string; placed: number; cost: number; ms: number }>;
}

export interface ProgressInfo {
  percent: number;
  phase: 'BUILD' | 'CONSTRUCT' | 'REPAIR' | 'OPTIMIZE' | 'FINALIZE';
  placed: number;
  total: number;
  cost: number;
}

export interface SolveHooks {
  onProgress?: (p: ProgressInfo) => void;
  /** вызывается периодически; true — остановить как можно скорее и вернуть лучший найденный результат */
  shouldStop?: () => boolean;
}

export const parseTime = (s: string): number => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};
export const fmtTime = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** mulberry32 — быстрый детерминированный PRNG (результат воспроизводим по seed) */
export function prng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
