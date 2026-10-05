import { DEFAULT_WEIGHTS, Level, PGroup, PRoom, PRule, PSlot, ParityMask, SolverParams, Weights } from './types';
import { DayItem, LATE_FROM, balanceCost, dayMetrics, groupDayCost, roomFitCost, spacingCost, teacherDayCost } from './soft';

/**
 * Conflict Checker — независимая проверка версии расписания (используется перед публикацией, после ручных правок
 * и в тестах движка как верификатор). Не зависит от внутренних структур солвера.
 */
export interface CLesson {
  id: string;
  requirementId: string | null;
  subjectId: string;
  teacherId: string | null;
  roomId: string | null;
  groups: string[];
  type: string;
  day: number;
  start: number;
  end: number;
  parity: ParityMask;
  level: Level;
}

export interface CRequirement {
  id: string;
  subjectId: string;
  teacherId: string | null;
  groups: string[];
  type: string;
  sessionsPerWeek: number;
  roomType?: string | null;
  features?: string[];
  isActive: boolean;
}

export interface CheckInput {
  lessons: CLesson[];
  rooms: PRoom[];
  groups: PGroup[];
  slots: PSlot[];
  rules: PRule[];
  workingDays: number[];
  requirements: CRequirement[];
  /** допустимые типы аудиторий для типа занятия (пусто — любые) */
  lessonTypeRooms: Record<string, string[]>;
  /** типы занятий, не требующие аудитории */
  roomlessTypes: string[];
  weights?: Weights;
  params?: Pick<SolverParams, 'maxConsecutive' | 'maxDaily' | 'longDayLimit'>;
  /** ограничить отчёт мягких нарушений (по умолчанию 2000) */
  softLimit?: number;
}

export type ConflictCode =
  | 'TEACHER_DOUBLE' | 'GROUP_DOUBLE' | 'ROOM_DOUBLE' | 'ROOM_CAPACITY' | 'ROOM_TYPE' | 'ROOM_FEATURES' | 'NO_ROOM'
  | 'TEACHER_UNAVAILABLE' | 'GROUP_UNAVAILABLE' | 'ROOM_UNAVAILABLE' | 'NON_WORKING_DAY' | 'OUT_OF_HOURS' | 'LEVEL_SLOT_MISMATCH'
  | 'DUPLICATE' | 'DAY_LIMIT' | 'BUILDING_NOT_ALLOWED' | 'MISSING_REQUIRED'
  | 'NO_TEACHER' | 'TEACHER_MISMATCH' | 'EXTRA_LESSONS' | 'OFF_GRID'
  | 'SOFT_GAPS' | 'SOFT_LONG_RUN' | 'SOFT_OVERLOAD' | 'SOFT_LONG_DAY' | 'SOFT_BUILDING_MOVES' | 'SOFT_LATE' | 'SOFT_UNBALANCED'
  | 'SOFT_SAME_DAY' | 'SOFT_ADJACENT_DAYS' | 'SOFT_TEACHER_GAPS' | 'SOFT_AVOID_TIME' | 'SOFT_ROOM_WASTE' | 'SOFT_BUILDING_PREFERENCE';

export interface Conflict {
  code: ConflictCode;
  severity: 'critical' | 'warning';
  lessonIds: string[];
  entity?: { type: 'teacher' | 'group' | 'room' | 'requirement' | 'subject'; id: string };
  params: Record<string, string | number | null>;
  cost?: number;
}

export interface CheckResult {
  critical: Conflict[];
  warnings: Conflict[];
  summary: {
    lessons: number;
    criticalCount: number;
    warningCount: number;
    softCost: number;
    totalChecks: number;
    compliancePct: number;
    byCode: Record<string, number>;
  };
}

const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;
const LEVELS: Level[] = ['BACHELOR', 'MASTER', 'PHD'];

export function checkLessons(inp: CheckInput): CheckResult {
  const w = inp.weights ?? DEFAULT_WEIGHTS;
  const params = inp.params ?? { maxConsecutive: 4, maxDaily: 5, longDayLimit: 6 };
  const critical: Conflict[] = [];
  const warnings: Conflict[] = [];
  const working = new Set(inp.workingDays);
  const roomById = new Map(inp.rooms.map((r) => [r.id, r]));
  const groupSize = new Map(inp.groups.map((g) => [g.name, g.size]));
  const groupLevel = new Map(inp.groups.map((g) => [g.name, g.level]));
  const slotsSorted = inp.slots.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const dayStart = slotsSorted.length ? Math.min(...slotsSorted.map((s) => s.start)) : 0;
  const dayEnd = slotsSorted.length ? Math.max(...slotsSorted.map((s) => s.end)) : 24 * 60;
  const gridUnique: PSlot[] = [];
  for (const s of slotsSorted) if (!gridUnique.some((u) => u.start === s.start && u.end === s.end)) gridUnique.push(s);
  const rankOfLesson = (l: { start: number; end: number }): number => {
    let best = -1, bestOv = 0;
    gridUnique.forEach((g, i) => { const ov = Math.min(l.end, g.end) - Math.max(l.start, g.start); if (ov > bestOv) { bestOv = ov; best = i; } });
    return best;
  };
  const levelSlots = LEVELS.map((lv) => slotsSorted.filter((s) => s.level === null || s.level === lv));
  const levelOrderOf = (lv: Level, l: { start: number; end: number }): number => levelSlots[LEVELS.indexOf(lv)].findIndex((s) => s.start === l.start && s.end === l.end);
  const slotOwnOrder = (s: PSlot) => levelSlots[LEVELS.indexOf(s.level ?? 'BACHELOR')].indexOf(s);

  const push = (c: Conflict) => (c.severity === 'critical' ? critical : warnings).push(c);

  // ── правила → «окна» по ресурсам ──
  interface Win { day: number; start: number; end: number; rule: PRule }
  const wins = { teacher: new Map<string, Win[]>(), group: new Map<string, Win[]>(), room: new Map<string, Win[]>(), building: new Map<string, Win[]>(), global: [] as Win[] };
  const slotByCode = new Map(inp.slots.map((s) => [s.code, s]));
  for (const r of inp.rules) {
    if (r.kind !== 'UNAVAILABLE' && r.kind !== 'NO_LATE') continue;
    const days = r.days.length ? r.days : inp.workingDays;
    let ss: PSlot[];
    if (r.kind === 'NO_LATE') { const from = Number(r.value?.fromOrder ?? 3); ss = inp.slots.filter((s) => slotOwnOrder(s) >= from); }
    else ss = r.slotCodes.length ? (r.slotCodes.map((c) => slotByCode.get(c)).filter(Boolean) as PSlot[]) : inp.slots;
    const list: Win[] = [];
    for (const d of days) for (const s of ss) list.push({ day: d, start: s.start, end: s.end, rule: r });
    const put = (m: Map<string, Win[]>, key: string) => m.set(key, (m.get(key) ?? []).concat(list));
    if (r.scope === 'TEACHER' && r.target) put(wins.teacher, r.target);
    else if (r.scope === 'GROUP' && r.target) put(wins.group, r.target);
    else if (r.scope === 'ROOM' && r.target) put(wins.room, r.target);
    else if (r.scope === 'BUILDING' && r.target) put(wins.building, r.target);
    else if (r.scope === 'GLOBAL') wins.global.push(...list);
  }
  const blockedBy = (list: Win[] | undefined, l: CLesson, hard: boolean): Win | undefined =>
    list?.find((x) => x.rule.hard === hard && x.day === l.day && overlap(x, l));

  let totalChecks = 0;
  const hardChecksPerLesson = 7;

  // ── 1. двойные бронирования ──
  const bucket = (key: (l: CLesson) => string[]) => {
    const m = new Map<string, CLesson[]>();
    for (const l of inp.lessons) for (const k of key(l)) { const a = m.get(k); if (a) a.push(l); else m.set(k, [l]); }
    return m;
  };
  const doubles = (m: Map<string, CLesson[]>, code: ConflictCode, type: 'teacher' | 'group' | 'room', keyOf: (k: string) => string) => {
    for (const [k, list] of m) {
      if (list.length < 2) continue;
      const byDay = new Map<number, CLesson[]>();
      for (const l of list) (byDay.get(l.day) ?? byDay.set(l.day, []).get(l.day)!).push(l);
      for (const [day, arr] of byDay) {
        if (arr.length < 2) continue;
        arr.sort((a, b) => a.start - b.start);
        for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
          const a = arr[i], b = arr[j];
          if (b.start >= a.end) break;
          if (!(a.parity & b.parity)) continue;
          // один и тот же поток (общая нагрузка, преподаватель, аудитория и время) — не конфликт
          push({ code, severity: 'critical', lessonIds: [a.id, b.id], entity: { type, id: keyOf(k) }, params: { day, aStart: a.start, bStart: b.start, aSubject: a.subjectId, bSubject: b.subjectId, aGroups: a.groups.join(', '), bGroups: b.groups.join(', ') } });
        }
      }
    }
  };
  doubles(bucket((l) => (l.teacherId ? [l.teacherId] : [])), 'TEACHER_DOUBLE', 'teacher', (k) => k);
  doubles(bucket((l) => l.groups), 'GROUP_DOUBLE', 'group', (k) => k);
  doubles(bucket((l) => (l.roomId ? [l.roomId] : [])), 'ROOM_DOUBLE', 'room', (k) => k);

  // ── 2. покомпонентные HARD ──
  const seenKey = new Map<string, CLesson>();
  for (const l of inp.lessons) {
    totalChecks += hardChecksPerLesson;
    const room = l.roomId ? roomById.get(l.roomId) : undefined;
    const roomless = inp.roomlessTypes.includes(l.type);
    if (!l.roomId) {
      if (!roomless) push({ code: 'NO_ROOM', severity: 'critical', lessonIds: [l.id], params: { subject: l.subjectId } });
    } else if (!room) {
      push({ code: 'NO_ROOM', severity: 'critical', lessonIds: [l.id], params: { subject: l.subjectId } });
    } else {
      const need = l.groups.reduce((a, g) => a + (groupSize.get(g) ?? 0), 0);
      if (need > room.capacity) push({ code: 'ROOM_CAPACITY', severity: 'critical', lessonIds: [l.id], entity: { type: 'room', id: room.id }, params: { need, capacity: room.capacity } });
      const req = l.requirementId ? inp.requirements.find((r) => r.id === l.requirementId) : undefined;
      const allowed = req?.roomType ? [req.roomType] : inp.lessonTypeRooms[l.type] ?? [];
      if (allowed.length && !allowed.includes(room.type)) push({ code: 'ROOM_TYPE', severity: 'critical', lessonIds: [l.id], entity: { type: 'room', id: room.id }, params: { roomType: room.type, allowed: allowed.join(', '), lessonType: l.type } });
      if (req?.features?.length && !req.features.every((f) => room.features.includes(f))) push({ code: 'ROOM_FEATURES', severity: 'critical', lessonIds: [l.id], entity: { type: 'room', id: room.id }, params: { missing: req.features.filter((f) => !room.features.includes(f)).join(', ') } });
      const rw = blockedBy(wins.room.get(room.id), l, true) ?? (room.building ? blockedBy(wins.building.get(room.building), l, true) : undefined);
      if (rw) push({ code: 'ROOM_UNAVAILABLE', severity: 'critical', lessonIds: [l.id], entity: { type: 'room', id: room.id }, params: { day: l.day, start: l.start } });
      // допустимые корпуса
      for (const r of inp.rules) {
        if (r.kind !== 'ALLOWED_BUILDINGS' || !r.hard || !r.target) continue;
        const set = new Set<string>(r.value?.buildings ?? []);
        const applies = (r.scope === 'GROUP' && l.groups.includes(r.target)) || (r.scope === 'TEACHER' && l.teacherId === r.target) || (r.scope === 'SUBJECT' && l.subjectId === r.target);
        if (applies && set.size && (!room.building || !set.has(room.building))) push({ code: 'BUILDING_NOT_ALLOWED', severity: 'critical', lessonIds: [l.id], entity: { type: r.scope === 'GROUP' ? 'group' : r.scope === 'TEACHER' ? 'teacher' : 'subject', id: r.target }, params: { building: room.building ?? '—', allowed: Array.from(set).join(', ') } });
      }
    }
    if (l.teacherId) {
      const x = blockedBy(wins.teacher.get(l.teacherId), l, true) ?? blockedBy(wins.global, l, true);
      if (x) push({ code: 'TEACHER_UNAVAILABLE', severity: 'critical', lessonIds: [l.id], entity: { type: 'teacher', id: l.teacherId }, params: { day: l.day, start: l.start } });
    } else push({ code: 'NO_TEACHER', severity: 'warning', lessonIds: [l.id], params: { subject: l.subjectId } });
    for (const g of l.groups) {
      const x = blockedBy(wins.group.get(g), l, true) ?? blockedBy(wins.global, l, true);
      if (x) push({ code: 'GROUP_UNAVAILABLE', severity: 'critical', lessonIds: [l.id], entity: { type: 'group', id: g }, params: { day: l.day, start: l.start } });
    }
    if (!working.has(l.day)) push({ code: 'NON_WORKING_DAY', severity: 'critical', lessonIds: [l.id], params: { day: l.day } });
    if (l.start < dayStart || l.end > dayEnd) push({ code: 'OUT_OF_HOURS', severity: 'critical', lessonIds: [l.id], params: { start: l.start, end: l.end, from: dayStart, to: dayEnd } });
    else {
      const onGrid = inp.slots.find((s) => s.start === l.start && s.end === l.end);
      if (!onGrid) push({ code: 'OFF_GRID', severity: 'warning', lessonIds: [l.id], params: { start: l.start, end: l.end } });
      else if (onGrid.level && onGrid.level !== l.level) push({ code: 'LEVEL_SLOT_MISMATCH', severity: 'critical', lessonIds: [l.id], params: { slotLevel: onGrid.level, lessonLevel: l.level } });
    }
    const dk = [l.groups.slice().sort().join('+'), l.subjectId, l.type, l.day, l.start, l.parity].join('|');
    const prev = seenKey.get(dk);
    if (prev) push({ code: 'DUPLICATE', severity: 'critical', lessonIds: [prev.id, l.id], params: { subject: l.subjectId, day: l.day, start: l.start } });
    else seenKey.set(dk, l);
  }

  // ── 3. MAX_PER_DAY (hard) ──
  const gDay = new Map<string, CLesson[]>(), tDay = new Map<string, CLesson[]>();
  for (const l of inp.lessons) {
    for (const g of l.groups) { const k = g + '|' + l.day; (gDay.get(k) ?? gDay.set(k, []).get(k)!).push(l); }
    if (l.teacherId) { const k = l.teacherId + '|' + l.day; (tDay.get(k) ?? tDay.set(k, []).get(k)!).push(l); }
  }
  for (const r of inp.rules) {
    if (r.kind !== 'MAX_PER_DAY' || !r.target) continue;
    const max = Number(r.value?.max ?? 0);
    if (!max) continue;
    const source = r.scope === 'GROUP' ? gDay : r.scope === 'TEACHER' ? tDay : null;
    if (!source) continue;
    for (const [k, list] of source) {
      const [id, day] = k.split('|');
      if (id !== r.target) continue;
      if (list.length > max) {
        const c: Conflict = { code: 'DAY_LIMIT', severity: r.hard ? 'critical' : 'warning', lessonIds: list.map((x) => x.id), entity: { type: r.scope === 'GROUP' ? 'group' : 'teacher', id }, params: { day: Number(day), count: list.length, max }, cost: r.hard ? undefined : r.weight * w.overload * (list.length - max) };
        push(c);
      }
    }
  }

  // ── 4. обязательные занятия ──
  const byReq = new Map<string, CLesson[]>();
  for (const l of inp.lessons) if (l.requirementId) (byReq.get(l.requirementId) ?? byReq.set(l.requirementId, []).get(l.requirementId)!).push(l);
  for (const r of inp.requirements) {
    if (!r.isActive) continue;
    totalChecks++;
    const have = byReq.get(r.id)?.length ?? 0;
    if (have < r.sessionsPerWeek) push({ code: 'MISSING_REQUIRED', severity: 'critical', lessonIds: (byReq.get(r.id) ?? []).map((x) => x.id), entity: { type: 'requirement', id: r.id }, params: { have, need: r.sessionsPerWeek, subject: r.subjectId, groups: r.groups.join(', '), type: r.type } });
    else if (have > r.sessionsPerWeek) push({ code: 'EXTRA_LESSONS', severity: 'warning', lessonIds: (byReq.get(r.id) ?? []).map((x) => x.id), entity: { type: 'requirement', id: r.id }, params: { have, need: r.sessionsPerWeek } });
    for (const l of byReq.get(r.id) ?? []) if (r.teacherId && l.teacherId && l.teacherId !== r.teacherId) push({ code: 'TEACHER_MISMATCH', severity: 'warning', lessonIds: [l.id], entity: { type: 'teacher', id: l.teacherId }, params: { expected: r.teacherId } });
  }

  // ── 5. SOFT ──
  const softLimit = inp.softLimit ?? 2000;
  let softCost = 0;
  const softPush = (c: Conflict) => { softCost += c.cost ?? 0; if (warnings.filter((x) => x.code.startsWith('SOFT_')).length < softLimit) warnings.push(c); };
  const itemsFor = (list: CLesson[], lv: Level | null): DayItem[] =>
    list.map((l) => {
      const room = l.roomId ? roomById.get(l.roomId) : undefined;
      return { rank: rankOfLesson(l), levelOrder: lv ? levelOrderOf(lv, l) : -1, building: room?.building ?? null };
    });
  const groupDays = new Map<string, CLesson[][]>();
  for (const [k, list] of gDay) {
    const [g, day] = k.split('|');
    totalChecks += 5;
    const m = dayMetrics(itemsFor(list, groupLevel.get(g) ?? list[0].level));
    const c = groupDayCost(m, w, params.maxConsecutive, params.maxDaily, params.longDayLimit);
    const ids = list.map((x) => x.id);
    const e = { type: 'group' as const, id: g };
    if (c.gap > 0) softPush({ code: 'SOFT_GAPS', severity: 'warning', lessonIds: ids, entity: e, params: { day: Number(day), gaps: m.gaps }, cost: c.gap });
    if (c.consecutive > 0) softPush({ code: 'SOFT_LONG_RUN', severity: 'warning', lessonIds: ids, entity: e, params: { day: Number(day), run: m.maxRun, max: params.maxConsecutive }, cost: c.consecutive });
    if (c.overload > 0) softPush({ code: 'SOFT_OVERLOAD', severity: 'warning', lessonIds: ids, entity: e, params: { day: Number(day), count: m.lessons, max: params.maxDaily }, cost: c.overload });
    if (c.longDay > 0) softPush({ code: 'SOFT_LONG_DAY', severity: 'warning', lessonIds: ids, entity: e, params: { day: Number(day), span: m.span, max: params.longDayLimit }, cost: c.longDay });
    if (c.building > 0) softPush({ code: 'SOFT_BUILDING_MOVES', severity: 'warning', lessonIds: ids, entity: e, params: { day: Number(day), moves: m.moves }, cost: c.building });
    if (c.late > 0) softPush({ code: 'SOFT_LATE', severity: 'warning', lessonIds: ids, entity: e, params: { day: Number(day), count: m.late, fromOrder: LATE_FROM + 1 }, cost: c.late });
    const arr = groupDays.get(g) ?? []; arr[Number(day) - 1] = list; groupDays.set(g, arr);
  }
  for (const [g, arr] of groupDays) {
    const counts = Array.from({ length: 7 }, (_, i) => (arr[i] ? arr[i].length : 0));
    const b = balanceCost(counts, inp.workingDays, w);
    if (b > 0) softPush({ code: 'SOFT_UNBALANCED', severity: 'warning', lessonIds: [], entity: { type: 'group', id: g }, params: { counts: counts.join('-') }, cost: b });
  }
  for (const [k, list] of tDay) {
    const [t, day] = k.split('|');
    totalChecks += 2;
    const m = dayMetrics(itemsFor(list, null));
    const c = teacherDayCost(m, w);
    const ids = list.map((x) => x.id);
    if (c.gap > 0) softPush({ code: 'SOFT_TEACHER_GAPS', severity: 'warning', lessonIds: ids, entity: { type: 'teacher', id: t }, params: { day: Number(day), gaps: m.gaps }, cost: c.gap });
    if (c.building > 0) softPush({ code: 'SOFT_BUILDING_MOVES', severity: 'warning', lessonIds: ids, entity: { type: 'teacher', id: t }, params: { day: Number(day), moves: m.moves }, cost: c.building });
  }
  // нежелательное время (мягкое UNAVAILABLE) и мягкие корпуса
  for (const l of inp.lessons) {
    const soft: Array<{ type: 'teacher' | 'group' | 'room'; id: string; win: Win }> = [];
    if (l.teacherId) { const x = blockedBy(wins.teacher.get(l.teacherId), l, false); if (x) soft.push({ type: 'teacher', id: l.teacherId, win: x }); }
    for (const g of l.groups) { const x = blockedBy(wins.group.get(g), l, false); if (x) soft.push({ type: 'group', id: g, win: x }); }
    if (l.roomId) { const x = blockedBy(wins.room.get(l.roomId), l, false); if (x) soft.push({ type: 'room', id: l.roomId, win: x }); }
    for (const s of soft) softPush({ code: 'SOFT_AVOID_TIME', severity: 'warning', lessonIds: [l.id], entity: { type: s.type, id: s.id }, params: { day: l.day, start: l.start }, cost: s.win.rule.weight * w.avoid });
    const room = l.roomId ? roomById.get(l.roomId) : undefined;
    if (room) {
      const need = l.groups.reduce((a, g) => a + (groupSize.get(g) ?? 0), 0);
      const waste = roomFitCost(room.capacity, need, w);
      if (need > 0 && room.capacity > need * 2.5) softPush({ code: 'SOFT_ROOM_WASTE', severity: 'warning', lessonIds: [l.id], entity: { type: 'room', id: room.id }, params: { need, capacity: room.capacity }, cost: waste });
      for (const r of inp.rules) {
        if (r.kind !== 'ALLOWED_BUILDINGS' || r.hard || !r.target) continue;
        const set = new Set<string>(r.value?.buildings ?? []);
        const applies = (r.scope === 'GROUP' && l.groups.includes(r.target)) || (r.scope === 'TEACHER' && l.teacherId === r.target) || (r.scope === 'SUBJECT' && l.subjectId === r.target);
        if (applies && set.size && (!room.building || !set.has(room.building))) softPush({ code: 'SOFT_BUILDING_PREFERENCE', severity: 'warning', lessonIds: [l.id], entity: { type: 'room', id: room.id }, params: { building: room.building ?? '—', preferred: Array.from(set).join(', ') }, cost: r.weight * w.avoid });
      }
    }
  }
  // разнесение занятий одной нагрузки по дням
  for (const [rid, list] of byReq) {
    if (list.length < 2) continue;
    const sp = spacingCost(list.map((x) => x.day), w);
    if (sp.sameDay > 0) softPush({ code: 'SOFT_SAME_DAY', severity: 'warning', lessonIds: list.map((x) => x.id), entity: { type: 'requirement', id: rid }, params: {}, cost: sp.sameDay });
    if (sp.adjacent > 0) softPush({ code: 'SOFT_ADJACENT_DAYS', severity: 'warning', lessonIds: list.map((x) => x.id), entity: { type: 'requirement', id: rid }, params: {}, cost: sp.adjacent });
  }

  const byCode: Record<string, number> = {};
  for (const c of [...critical, ...warnings]) byCode[c.code] = (byCode[c.code] ?? 0) + 1;
  const bad = critical.length + warnings.length;
  const compliancePct = totalChecks ? Math.max(0, Math.round((1 - bad / totalChecks) * 1000) / 10) : 100;
  return {
    critical,
    warnings,
    summary: { lessons: inp.lessons.length, criticalCount: critical.length, warningCount: warnings.length, softCost: Math.round(softCost * 10) / 10, totalChecks, compliancePct, byCode },
  };
}
