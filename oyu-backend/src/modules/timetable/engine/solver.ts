import {
  Assignment, Level, PRule, PSession, PSlot, Problem, ProgressInfo, SolveHooks, SolveResult, Unplaced, UnplacedCode, prng,
} from './types';
import { DayItem, balanceCost, dayMetrics, groupDayCost, roomFitCost, spacingCost, teacherDayCost } from './soft';

/**
 * Scheduling Engine — оптимизация с ограничениями (constraint optimization).
 *
 * Модель: переменная = (день, стартовая пара, аудитория) для каждого занятия; домены ограничены статически
 * (уровень группы → пары сетки, вместимость/тип/оборудование/корпус → список допустимых аудиторий).
 * HARD-ограничения проверяются через индексы занятости (преподаватель/группа/аудитория × день × интервал, с учётом
 * пересечения интервалов и чётности недели) и НИКОГДА не нарушаются: любое состояние поиска допустимо.
 *
 * Фазы:
 *  1. CONSTRUCT — конструктивное построение: занятия упорядочены по «жёсткости» (потоки, длинные, загруженные
 *     преподаватели, дефицитные аудитории — первыми), для каждого перебираются позиции домена с forward-checking,
 *     выбирается позиция с минимальной добавочной мягкой ценой (best-fit аудитория).
 *  2. REPAIR — для неразмещённых: ejection chain (вытесняется блокирующее занятие, затем оно переразмещается).
 *  3. OPTIMIZE — simulated annealing по мягкой цене: ходы relocate / смена аудитории / swap; принимаются только
 *     допустимые состояния; инкрементальный пересчёт цены затронутых (сущность × день).
 *  4. Повторная вставка неразмещённых после реорганизации.
 */
const D = 7;
const UNPLACED_ORDER: UnplacedCode[] = ['NO_WORKING_DAYS', 'NO_SLOT_FOR_LEVEL', 'NO_ROOM_FITS', 'TEACHER_UNAVAILABLE', 'GROUP_UNAVAILABLE', 'DAY_LIMIT', 'TEACHER_BUSY', 'GROUP_BUSY', 'ROOMS_BUSY'];

interface Start {
  slot: number; // индекс в problem.slots
  intervals: number[];
  slotIds: string[];
  end: number;
  start: number;
}

interface Placement {
  id: number;
  session: PSession | null;
  fixed: boolean;
  groups: number[];
  teacher: number;
  parity: number;
  duration: number;
  reqKey: number;
  need: number;
  needsRoom: boolean;
  rooms: Int32Array; // допустимые аудитории (по возрастанию вместимости)
  starts: Start[];
  levelIdx: number;
  // текущее положение
  placed: boolean;
  day: number; // 1..7
  startPos: number; // индекс в starts (-1 для фиксированных)
  intervals: number[];
  room: number; // -1 нет
  ranks: number[]; // позиции интервалов в сетке (для метрик)
  lowIdx: number[];
}

type Occ = Uint8Array;

export function solve(problem: Problem, hooks: SolveHooks = {}): SolveResult {
  const t0 = Date.now();
  const rnd = prng(problem.params.seed);
  const w = problem.weights;
  const { maxConsecutive, maxDaily, longDayLimit } = problem.params;
  const workingDays = Array.from(new Set(problem.days.filter((d) => d >= 1 && d <= 7))).sort((a, b) => a - b);
  const isWorking = new Uint8Array(D + 1);
  workingDays.forEach((d) => (isWorking[d] = 1));

  // ───────────────────────── интервалы и сетка ─────────────────────────
  const slots: PSlot[] = problem.slots.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const intervalKey = (s: number, e: number) => s * 2000 + e;
  const intervalIndex = new Map<number, number>();
  const iStart: number[] = [];
  const iEnd: number[] = [];
  const addInterval = (s: number, e: number) => {
    const k = intervalKey(s, e);
    let i = intervalIndex.get(k);
    if (i === undefined) { i = iStart.length; intervalIndex.set(k, i); iStart.push(s); iEnd.push(e); }
    return i;
  };
  const slotInterval = slots.map((s) => addInterval(s.start, s.end));
  const gridCount = iStart.length;
  for (const f of problem.fixed) addInterval(f.start, f.end);
  const NI = iStart.length;
  const overlap: number[][] = Array.from({ length: NI }, () => []);
  for (let i = 0; i < NI; i++) for (let j = 0; j < NI; j++) if (iStart[i] < iEnd[j] && iStart[j] < iEnd[i]) overlap[i].push(j);

  // ранг интервала в общей сетке (для окон/цепочек); для нестандартных — интервал сетки с максимальным пересечением
  const gridSorted = Array.from({ length: gridCount }, (_, i) => i).sort((a, b) => iStart[a] - iStart[b]);
  const rankOf = new Int32Array(NI).fill(-1);
  gridSorted.forEach((iv, r) => (rankOf[iv] = r));
  for (let i = gridCount; i < NI; i++) {
    let best = -1, bestOv = 0;
    for (const g of gridSorted) { const ov = Math.min(iEnd[i], iEnd[g]) - Math.max(iStart[i], iStart[g]); if (ov > bestOv) { bestOv = ov; best = g; } }
    rankOf[i] = best >= 0 ? rankOf[best] : -1;
  }
  const LEVELS: Level[] = ['BACHELOR', 'MASTER', 'PHD'];
  const levelSlots: number[][] = LEVELS.map((lv) => slots.map((s, i) => (s.level === null || s.level === lv ? i : -1)).filter((i) => i >= 0));
  const lowOf: Int32Array[] = LEVELS.map((_, li) => {
    const arr = new Int32Array(NI).fill(-1);
    levelSlots[li].forEach((si, order) => (arr[slotInterval[si]] = order));
    return arr;
  });
  // порядковый номер пары внутри собственного уровня — для правил NO_LATE
  const slotOwnOrder = slots.map((s) => {
    const li = s.level ? LEVELS.indexOf(s.level) : 0;
    return levelSlots[li].indexOf(slots.indexOf(s));
  });
  const levelIdxOf = (l: Level) => Math.max(0, LEVELS.indexOf(l));

  // ───────────────────────── ресурсы ─────────────────────────
  const groupIdx = new Map<string, number>();
  const groupSize: number[] = [];
  const groupLevel: number[] = [];
  for (const g of problem.groups) { groupIdx.set(g.name, groupSize.length); groupSize.push(g.size); groupLevel.push(levelIdxOf(g.level)); }
  const ensureGroup = (name: string, level = 0) => {
    let i = groupIdx.get(name);
    if (i === undefined) { i = groupSize.length; groupIdx.set(name, i); groupSize.push(0); groupLevel.push(level); }
    return i;
  };
  const teacherIdx = new Map<string, number>();
  problem.teachers.forEach((t, i) => teacherIdx.set(t.id, i));
  const ensureTeacher = (id: string) => { let i = teacherIdx.get(id); if (i === undefined) { i = teacherIdx.size; teacherIdx.set(id, i); } return i; };
  const roomIdx = new Map<string, number>();
  problem.rooms.forEach((r, i) => roomIdx.set(r.id, i));
  const rooms = problem.rooms;

  for (const s of problem.sessions) { for (const g of s.groups) ensureGroup(g, levelIdxOf(s.level)); if (s.teacherId) ensureTeacher(s.teacherId); }
  for (const f of problem.fixed) { for (const g of f.groups) ensureGroup(g); if (f.teacherId) ensureTeacher(f.teacherId); }
  const NG = groupSize.length, NT = teacherIdx.size, NR = rooms.length;

  const mk = (n: number) => new Uint8Array(Math.max(1, n * D * NI));
  const gOcc: Occ = mk(NG), tOcc: Occ = mk(NT), rOcc: Occ = mk(NR);
  const gBlock: Occ = mk(NG), tBlock: Occ = mk(NT), rBlock: Occ = mk(NR);
  const mkf = (n: number) => new Float32Array(Math.max(1, n * D * NI));
  const gPen = mkf(NG), tPen = mkf(NT), rPen = mkf(NR);
  const ix = (res: number, d: number, i: number) => (res * D + (d - 1)) * NI + i;
  const subjBlock = new Map<string, Occ>();
  const gHardCap = new Int16Array(NG).fill(0), tHardCap = new Int16Array(NT).fill(0);
  const gSoftCap = new Int16Array(NG).fill(0), tSoftCap = new Int16Array(NT).fill(0);
  const gSoftCapW = new Float32Array(NG), tSoftCapW = new Float32Array(NT);
  const gBuildings = new Map<number, { set: Set<string>; hard: boolean; weight: number }>();
  const tBuildings = new Map<number, { set: Set<string>; hard: boolean; weight: number }>();
  const sBuildings = new Map<string, { set: Set<string>; hard: boolean; weight: number }>();

  // ───────────────────────── правила → массивы ─────────────────────────
  const slotByCode = new Map(slots.map((s, i) => [s.code, i]));
  const ruleIntervals = (r: PRule): Array<[number, number]> => {
    const days = r.days.length ? r.days.filter((d) => isWorking[d]) : workingDays;
    let slotIds: number[];
    if (r.kind === 'NO_LATE') {
      const from = Number(r.value?.fromOrder ?? 3);
      slotIds = slots.map((_, i) => i).filter((i) => slotOwnOrder[i] >= from);
    } else if (r.slotCodes.length) slotIds = r.slotCodes.map((c) => slotByCode.get(c)).filter((x): x is number => x !== undefined);
    else slotIds = slots.map((_, i) => i);
    const out: Array<[number, number]> = [];
    for (const d of days) for (const si of slotIds) out.push([d, slotInterval[si]]);
    return out;
  };
  const markBlocked = (arr: Occ, res: number, d: number, i: number) => { for (const j of overlap[i]) arr[ix(res, d, j)] = 1; };
  const addPen = (arr: Float32Array, res: number, d: number, i: number, v: number) => { for (const j of overlap[i]) arr[ix(res, d, j)] += v; };
  const targetsOf = (r: PRule): { kind: 'g' | 't' | 'r' | 's'; idx: number[]; subject?: string }[] => {
    switch (r.scope) {
      case 'TEACHER': { const i = r.target ? teacherIdx.get(r.target) : undefined; return i === undefined ? [] : [{ kind: 't', idx: [i] }]; }
      case 'GROUP': { const i = r.target ? groupIdx.get(r.target) : undefined; return i === undefined ? [] : [{ kind: 'g', idx: [i] }]; }
      case 'ROOM': { const i = r.target ? roomIdx.get(r.target) : undefined; return i === undefined ? [] : [{ kind: 'r', idx: [i] }]; }
      case 'BUILDING': return [{ kind: 'r', idx: rooms.map((x, i) => (x.building === r.target ? i : -1)).filter((i) => i >= 0) }];
      case 'SUBJECT': return r.target ? [{ kind: 's', idx: [], subject: r.target }] : [];
      default: return [
        { kind: 'g', idx: Array.from({ length: NG }, (_, i) => i) },
        { kind: 't', idx: Array.from({ length: NT }, (_, i) => i) },
        { kind: 'r', idx: Array.from({ length: NR }, (_, i) => i) },
      ];
    }
  };
  for (const r of problem.rules) {
    const tg = targetsOf(r);
    if (r.kind === 'UNAVAILABLE' || r.kind === 'NO_LATE') {
      const ivs = ruleIntervals(r);
      for (const t of tg) {
        if (t.kind === 's') {
          const arr = subjBlock.get(t.subject!) ?? new Uint8Array(D * NI); subjBlock.set(t.subject!, arr);
          if (r.hard) for (const [d, i] of ivs) for (const j of overlap[i]) arr[(d - 1) * NI + j] = 1;
          continue;
        }
        const blk = t.kind === 'g' ? gBlock : t.kind === 't' ? tBlock : rBlock;
        const pen = t.kind === 'g' ? gPen : t.kind === 't' ? tPen : rPen;
        for (const res of t.idx) for (const [d, i] of ivs) {
          if (r.hard) markBlocked(blk, res, d, i); else addPen(pen, res, d, i, r.weight * w.avoid);
        }
      }
    } else if (r.kind === 'PREFERRED') {
      const ivs = ruleIntervals(r);
      for (const t of tg) {
        if (t.kind === 's') continue;
        const pen = t.kind === 'g' ? gPen : t.kind === 't' ? tPen : rPen;
        for (const res of t.idx) for (const [d, i] of ivs) addPen(pen, res, d, i, -r.weight * w.prefer);
      }
    } else if (r.kind === 'MAX_PER_DAY') {
      const max = Math.max(0, Number(r.value?.max ?? 0));
      if (!max) continue;
      for (const t of tg) {
        if (t.kind === 'g') for (const res of t.idx) { if (r.hard) gHardCap[res] = gHardCap[res] ? Math.min(gHardCap[res], max) : max; else { gSoftCap[res] = max; gSoftCapW[res] = r.weight * w.overload; } }
        if (t.kind === 't') for (const res of t.idx) { if (r.hard) tHardCap[res] = tHardCap[res] ? Math.min(tHardCap[res], max) : max; else { tSoftCap[res] = max; tSoftCapW[res] = r.weight * w.overload; } }
      }
    } else if (r.kind === 'ALLOWED_BUILDINGS') {
      const set = new Set<string>((r.value?.buildings ?? []) as string[]);
      if (!set.size) continue;
      for (const t of tg) {
        if (t.kind === 'g') for (const res of t.idx) gBuildings.set(res, { set, hard: r.hard, weight: r.weight * w.avoid });
        if (t.kind === 't') for (const res of t.idx) tBuildings.set(res, { set, hard: r.hard, weight: r.weight * w.avoid });
        if (t.kind === 's') sBuildings.set(t.subject!, { set, hard: r.hard, weight: r.weight * w.avoid });
      }
    }
  }

  // ───────────────────────── занятия ─────────────────────────
  const reqKeys = new Map<string, number>();
  const reqKeyOf = (id: string | null | undefined, fallback: string) => {
    const k = id ?? fallback;
    let v = reqKeys.get(k);
    if (v === undefined) { v = reqKeys.size; reqKeys.set(k, v); }
    return v;
  };
  const PL: Placement[] = [];
  const startsCache = new Map<string, Start[]>();
  const startsFor = (li: number, duration: number): Start[] => {
    const key = li + ':' + duration;
    let c = startsCache.get(key);
    if (c) return c;
    c = [];
    const L = levelSlots[li];
    for (let p = 0; p + duration <= L.length; p++) {
      let ok = true;
      for (let k = 1; k < duration; k++) {
        const a = slots[L[p + k - 1]], b = slots[L[p + k]];
        if ((a.shift ?? '') !== (b.shift ?? '')) { ok = false; break; }
      }
      if (!ok) continue;
      const ss = L.slice(p, p + duration);
      c.push({ slot: ss[0], intervals: ss.map((i) => slotInterval[i]), slotIds: ss.map((i) => slots[i].id), start: slots[ss[0]].start, end: slots[ss[ss.length - 1]].end });
    }
    startsCache.set(key, c);
    return c;
  };
  const roomOrder = rooms.map((_, i) => i).sort((a, b) => rooms[a].capacity - rooms[b].capacity || rooms[a].code.localeCompare(rooms[b].code));

  for (const s of problem.sessions) {
    const gs = s.groups.map((g) => groupIdx.get(g)!);
    const need = gs.reduce((a, g) => a + groupSize[g], 0);
    const li = levelIdxOf(s.level);
    const teacher = s.teacherId ? teacherIdx.get(s.teacherId)! : -1;
    const feasible: number[] = [];
    for (const r of roomOrder) {
      const room = rooms[r];
      if (room.capacity < need) continue;
      if (s.roomTypes.length && !s.roomTypes.includes(room.type)) continue;
      if (s.features.length && !s.features.every((f) => room.features.includes(f))) continue;
      let ok = true;
      const hardB = [...gs.map((g) => gBuildings.get(g)), teacher >= 0 ? tBuildings.get(teacher) : undefined, sBuildings.get(s.subjectId)];
      for (const b of hardB) if (b && b.hard && (!room.building || !b.set.has(room.building))) { ok = false; break; }
      if (ok) feasible.push(r);
    }
    PL.push({
      id: PL.length, session: s, fixed: false, groups: gs, teacher, parity: s.parity, duration: s.duration, reqKey: reqKeyOf(s.requirementId, s.id), need, needsRoom: s.needsRoom !== false,
      rooms: Int32Array.from(feasible), starts: startsFor(li, s.duration), levelIdx: li,
      placed: false, day: 0, startPos: -1, intervals: [], room: -1, ranks: [], lowIdx: [],
    });
  }
  const movable = PL.length;
  const nSessions = movable;

  // ───────────────────────── списки по дням ─────────────────────────
  const gDay: Placement[][] = Array.from({ length: NG * D }, () => []);
  const tDay: Placement[][] = Array.from({ length: NT * D }, () => []);
  const rDay: Placement[][] = Array.from({ length: NR * D }, () => []);
  const gCount = new Int16Array(NG * D);
  const reqPlaced: Placement[][] = [];
  const getReq = (k: number) => reqPlaced[k] ?? (reqPlaced[k] = []);
  const buildingOf = (r: number) => (r >= 0 ? rooms[r].building : null);

  const occSet = (arr: Occ, res: number, d: number, i: number, parity: number, on: boolean) => {
    const k = ix(res, d, i);
    arr[k] = on ? arr[k] | parity : arr[k] & ~parity;
  };
  const free = (arr: Occ, res: number, d: number, i: number, parity: number) => {
    const base = (res * D + (d - 1)) * NI;
    const ov = overlap[i];
    for (let a = 0; a < ov.length; a++) if (arr[base + ov[a]] & parity) return false;
    return true;
  };

  function applyPlace(p: Placement, d: number, startPos: number, room: number) {
    const st = p.starts[startPos];
    p.day = d; p.startPos = startPos; p.intervals = st.intervals; p.room = room; p.placed = true;
    p.ranks = st.intervals.map((i) => rankOf[i]);
    p.lowIdx = st.intervals.map((i) => lowOf[p.levelIdx][i]);
    for (const i of st.intervals) {
      for (const g of p.groups) occSet(gOcc, g, d, i, p.parity, true);
      if (p.teacher >= 0) occSet(tOcc, p.teacher, d, i, p.parity, true);
      if (room >= 0) occSet(rOcc, room, d, i, p.parity, true);
    }
    for (const g of p.groups) { gDay[g * D + d - 1].push(p); gCount[g * D + d - 1] += p.duration; }
    if (p.teacher >= 0) tDay[p.teacher * D + d - 1].push(p);
    if (room >= 0) rDay[room * D + d - 1].push(p);
    getReq(p.reqKey).push(p);
  }
  function applyRemove(p: Placement) {
    const d = p.day;
    for (const i of p.intervals) {
      for (const g of p.groups) occSet(gOcc, g, d, i, p.parity, false);
      if (p.teacher >= 0) occSet(tOcc, p.teacher, d, i, p.parity, false);
      if (p.room >= 0) occSet(rOcc, p.room, d, i, p.parity, false);
    }
    const rm = (arr: Placement[]) => { const k = arr.indexOf(p); if (k >= 0) arr.splice(k, 1); };
    for (const g of p.groups) { rm(gDay[g * D + d - 1]); gCount[g * D + d - 1] -= p.duration; }
    if (p.teacher >= 0) rm(tDay[p.teacher * D + d - 1]);
    if (p.room >= 0) rm(rDay[p.room * D + d - 1]);
    rm(getReq(p.reqKey));
    p.placed = false;
  }

  // фиксированные занятия
  for (const f of problem.fixed) {
    const gs = f.groups.map((g) => groupIdx.get(g)!);
    const iv = addInterval(f.start, f.end);
    const p: Placement = {
      id: PL.length, session: null, fixed: true, groups: gs, teacher: f.teacherId ? teacherIdx.get(f.teacherId)! : -1, parity: f.parity, duration: 1,
      reqKey: reqKeyOf(f.requirementId ?? null, 'fixed:' + f.id), need: 0, needsRoom: false, rooms: new Int32Array(0), starts: [], levelIdx: gs.length ? groupLevel[gs[0]] : 0,
      placed: false, day: f.day, startPos: -1, intervals: [iv], room: f.roomId ? roomIdx.get(f.roomId) ?? -1 : -1, ranks: [], lowIdx: [],
    };
    p.ranks = [rankOf[iv]];
    p.lowIdx = [lowOf[p.levelIdx][iv]];
    for (const g of gs) occSet(gOcc, g, f.day, iv, f.parity, true);
    if (p.teacher >= 0) occSet(tOcc, p.teacher, f.day, iv, f.parity, true);
    if (p.room >= 0) occSet(rOcc, p.room, f.day, iv, f.parity, true);
    for (const g of gs) { gDay[g * D + f.day - 1].push(p); gCount[g * D + f.day - 1] += 1; }
    if (p.teacher >= 0) tDay[p.teacher * D + f.day - 1].push(p);
    if (p.room >= 0) rDay[p.room * D + f.day - 1].push(p);
    getReq(p.reqKey).push(p);
    p.placed = true;
    PL.push(p);
  }

  // ───────────────────────── допустимость (HARD) ─────────────────────────
  const timeCode = (p: Placement, d: number, st: Start): UnplacedCode | 0 => {
    if (!isWorking[d]) return 'NO_WORKING_DAYS';
    const sb = p.session ? subjBlock.get(p.session.subjectId) : undefined;
    for (const i of st.intervals) {
      if (p.teacher >= 0 && tBlock[ix(p.teacher, d, i)]) return 'TEACHER_UNAVAILABLE';
      for (const g of p.groups) if (gBlock[ix(g, d, i)]) return 'GROUP_UNAVAILABLE';
      if (sb && sb[(d - 1) * NI + i]) return 'GROUP_UNAVAILABLE';
    }
    for (const g of p.groups) {
      const cap = gHardCap[g];
      if (cap && gCount[g * D + d - 1] + p.duration > cap) return 'DAY_LIMIT';
    }
    if (p.teacher >= 0 && tHardCap[p.teacher] && countTeacherDay(p.teacher, d) + p.duration > tHardCap[p.teacher]) return 'DAY_LIMIT';
    for (const i of st.intervals) {
      if (p.teacher >= 0 && !free(tOcc, p.teacher, d, i, p.parity)) return 'TEACHER_BUSY';
      for (const g of p.groups) if (!free(gOcc, g, d, i, p.parity)) return 'GROUP_BUSY';
    }
    return 0;
  };
  const countTeacherDay = (t: number, d: number) => { let n = 0; for (const q of tDay[t * D + d - 1]) n += q.duration; return n; };
  const roomFits = (r: number, d: number, st: Start, parity: number) => {
    for (const i of st.intervals) if (rBlock[ix(r, d, i)] || !free(rOcc, r, d, i, parity)) return false;
    return true;
  };
  const pickRoom = (p: Placement, d: number, st: Start): number => {
    for (let k = 0; k < p.rooms.length; k++) if (roomFits(p.rooms[k], d, st, p.parity)) return p.rooms[k];
    return -1;
  };

  // ───────────────────────── мягкая цена ─────────────────────────
  const itemsOf = (list: Placement[], isGroup: boolean, levelIdx: number): DayItem[] => {
    const out: DayItem[] = [];
    for (const q of list) for (let k = 0; k < q.intervals.length; k++) {
      out.push({ rank: q.ranks[k], levelOrder: isGroup ? lowOf[levelIdx][q.intervals[k]] : -1, building: buildingOf(q.room) });
    }
    return out;
  };
  const groupDayC = (g: number, d: number): number => {
    const m = dayMetrics(itemsOf(gDay[g * D + d - 1], true, groupLevel[g]));
    let c = groupDayCost(m, w, maxConsecutive, maxDaily, longDayLimit).total;
    if (gSoftCap[g] && m.lessons > gSoftCap[g]) c += gSoftCapW[g] * (m.lessons - gSoftCap[g]);
    return c;
  };
  const teacherDayC = (t: number, d: number): number => {
    const m = dayMetrics(itemsOf(tDay[t * D + d - 1], false, 0));
    let c = teacherDayCost(m, w).total;
    if (tSoftCap[t] && m.lessons > tSoftCap[t]) c += tSoftCapW[t] * (m.lessons - tSoftCap[t]);
    return c;
  };
  const prefCost = (p: Placement): number => {
    if (!p.placed || p.fixed) return 0;
    let c = 0;
    for (const i of p.intervals) {
      for (const g of p.groups) c += gPen[ix(g, p.day, i)];
      if (p.teacher >= 0) c += tPen[ix(p.teacher, p.day, i)];
      if (p.room >= 0) c += rPen[ix(p.room, p.day, i)];
    }
    if (p.room >= 0) {
      const b = rooms[p.room].building;
      for (const g of p.groups) { const x = gBuildings.get(g); if (x && !x.hard && (!b || !x.set.has(b))) c += x.weight; }
      const tb = p.teacher >= 0 ? tBuildings.get(p.teacher) : undefined;
      if (tb && !tb.hard && (!b || !tb.set.has(b))) c += tb.weight;
      const sb = sBuildings.get(p.session!.subjectId);
      if (sb && !sb.hard && (!b || !sb.set.has(b))) c += sb.weight;
      c += roomFitCost(rooms[p.room].capacity, p.need, w);
    }
    return c;
  };
  const reqCost = (k: number): number => {
    const arr = reqPlaced[k];
    if (!arr || arr.length < 2) return 0;
    return spacingCost(arr.map((q) => q.day), w).total;
  };
  const gBalance = (g: number) => balanceCost(gCount.subarray(g * D, g * D + D), workingDays, w);

  /** Цена всех сущностей, затронутых занятиями ps в днях days (p может быть не размещено — тогда вклад только остальных) */
  const costAround = (ps: Placement[], days: number[]): number => {
    const gs = new Set<number>(), ts = new Set<number>(), rs = new Set<number>();
    for (const p of ps) { p.groups.forEach((g) => gs.add(g)); if (p.teacher >= 0) ts.add(p.teacher); rs.add(p.reqKey); }
    let c = 0;
    for (const g of gs) { for (const d of days) c += groupDayC(g, d); c += gBalance(g); }
    for (const t of ts) for (const d of days) c += teacherDayC(t, d);
    for (const k of rs) c += reqCost(k);
    for (const p of ps) c += prefCost(p);
    return c;
  };

  // ───────────────────────── поиск позиции ─────────────────────────
  const orderedDays = workingDays.slice();
  interface Cand { d: number; sp: number; room: number; delta: number }

  function bestPosition(p: Placement, tally?: Partial<Record<UnplacedCode, number>>): Cand | null {
    let best: Cand | null = null;
    let ties = 0;
    const base: Record<number, number> = {};
    for (const d of orderedDays) {
      for (let sp = 0; sp < p.starts.length; sp++) {
        const st = p.starts[sp];
        const code = timeCode(p, d, st);
        if (code) { if (tally) tally[code] = (tally[code] ?? 0) + 1; continue; }
        const room = p.needsRoom ? pickRoom(p, d, st) : -1;
        if (p.needsRoom && room < 0) { if (tally) tally.ROOMS_BUSY = (tally.ROOMS_BUSY ?? 0) + 1; continue; }
        if (base[d] === undefined) base[d] = costAround([p], [d]);
        applyPlace(p, d, sp, room);
        const delta = costAround([p], [d]) - base[d];
        applyRemove(p);
        if (!best || delta < best.delta - 1e-9) { best = { d, sp, room, delta }; ties = 1; }
        else if (Math.abs(delta - best.delta) <= 1e-9) { ties++; if (rnd() < 1 / ties) best = { d, sp, room, delta }; }
      }
    }
    return best;
  }

  function diagnose(p: Placement): Unplaced {
    const tally: Partial<Record<UnplacedCode, number>> = {};
    if (!workingDays.length) return { sessionId: p.session!.id, code: 'NO_WORKING_DAYS', tally };
    if (!p.starts.length) return { sessionId: p.session!.id, code: 'NO_SLOT_FOR_LEVEL', tally };
    if (p.needsRoom && !p.rooms.length) return { sessionId: p.session!.id, code: 'NO_ROOM_FITS', tally };
    bestPosition(p, tally);
    const code = UNPLACED_ORDER.filter((c) => (tally[c] ?? 0) > 0).sort((a, b) => (tally[b] ?? 0) - (tally[a] ?? 0))[0] ?? 'GROUP_BUSY';
    return { sessionId: p.session!.id, code, tally };
  }

  const commitBest = (p: Placement): boolean => {
    const b = bestPosition(p);
    if (!b) return false;
    applyPlace(p, b.d, b.sp, b.room);
    return true;
  };

  // ───────────────────────── ejection chain ─────────────────────────
  function blockersAt(p: Placement, d: number, st: Start): Placement[] | null {
    const set = new Set<Placement>();
    for (const i of st.intervals) {
      const conflicts = (list: Placement[]) => {
        for (const q of list) {
          if (!(q.parity & p.parity)) continue;
          for (const qi of q.intervals) if (iStart[qi] < iEnd[i] && iStart[i] < iEnd[qi]) { set.add(q); break; }
        }
      };
      if (p.teacher >= 0) conflicts(tDay[p.teacher * D + d - 1]);
      for (const g of p.groups) conflicts(gDay[g * D + d - 1]);
    }
    for (const q of set) if (q.fixed) return null;
    return Array.from(set);
  }

  function tryEject(p: Placement, budget: number): boolean {
    const order: Array<[number, number]> = [];
    for (const d of orderedDays) for (let sp = 0; sp < p.starts.length; sp++) order.push([d, sp]);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    let tries = 0;
    for (const [d, sp] of order) {
      if (tries >= budget) break;
      const st = p.starts[sp];
      const hard = timeCode(p, d, st);
      if (hard === 'TEACHER_UNAVAILABLE' || hard === 'GROUP_UNAVAILABLE' || hard === 'NO_WORKING_DAYS' || hard === 'DAY_LIMIT') continue;
      const bl = blockersAt(p, d, st);
      if (!bl || bl.length !== 1 || hard === 0) continue;
      tries++;
      const b = bl[0];
      const old = { d: b.day, sp: b.startPos, room: b.room };
      applyRemove(b);
      if (timeCode(p, d, st) === 0) {
        const room = p.needsRoom ? pickRoom(p, d, st) : -1;
        if (room >= 0 || !p.needsRoom) {
          applyPlace(p, d, sp, room);
          if (commitBest(b)) return true;
          applyRemove(p);
        }
      }
      applyPlace(b, old.d, old.sp, old.room);
    }
    // кейс «нет свободной аудитории»: вытесняем единственного арендатора подходящей аудитории
    tries = 0;
    for (const [d, sp] of order) {
      if (tries >= budget) break;
      const st = p.starts[sp];
      if (timeCode(p, d, st) !== 0) continue;
      if (pickRoom(p, d, st) >= 0) continue;
      for (const r of p.rooms) {
        const occ = rDay[r * D + d - 1].filter((q) => (q.parity & p.parity) && q.intervals.some((qi) => st.intervals.some((i) => iStart[qi] < iEnd[i] && iStart[i] < iEnd[qi])));
        if (occ.length !== 1 || occ[0].fixed || rBlock[ix(r, d, st.intervals[0])]) continue;
        tries++;
        const b = occ[0];
        const old = { d: b.day, sp: b.startPos, room: b.room };
        applyRemove(b);
        if (roomFits(r, d, st, p.parity) && timeCode(p, d, st) === 0) {
          applyPlace(p, d, sp, r);
          if (commitBest(b)) return true;
          applyRemove(p);
        }
        applyPlace(b, old.d, old.sp, old.room);
        break;
      }
    }
    return false;
  }

  // ───────────────────────── прогресс ─────────────────────────
  let lastTick = 0;
  const placedCount = () => { let n = 0; for (let k = 0; k < movable; k++) if (PL[k].placed) n++; return n; };
  let curCost = 0;
  const tick = (phase: ProgressInfo['phase'], percent: number, force = false) => {
    const now = Date.now();
    if (!force && now - lastTick < 250) return;
    lastTick = now;
    hooks.onProgress?.({ percent: Math.min(99, Math.round(percent)), phase, placed: placedCount(), total: nSessions, cost: Math.round(curCost * 10) / 10 });
  };
  const stopRequested = () => !!hooks.shouldStop?.();
  const phases: SolveResult['phases'] = [];
  const mark = (phase: string, since: number) => phases.push({ phase, placed: placedCount(), cost: Math.round(fullCost().total * 10) / 10, ms: Date.now() - since });

  function fullCost(): { total: number; breakdown: Record<string, number> } {
    const b: Record<string, number> = { gap: 0, consecutive: 0, overload: 0, longDay: 0, building: 0, late: 0, balance: 0, teacherGap: 0, teacherBuilding: 0, preferences: 0, spacing: 0, roomFit: 0 };
    for (let g = 0; g < NG; g++) {
      for (const d of workingDays) {
        const m = dayMetrics(itemsOf(gDay[g * D + d - 1], true, groupLevel[g]));
        const c = groupDayCost(m, w, maxConsecutive, maxDaily, longDayLimit);
        b.gap += c.gap; b.consecutive += c.consecutive; b.overload += c.overload; b.longDay += c.longDay; b.building += c.building; b.late += c.late;
        if (gSoftCap[g] && m.lessons > gSoftCap[g]) b.overload += gSoftCapW[g] * (m.lessons - gSoftCap[g]);
      }
      b.balance += gBalance(g);
    }
    for (let t = 0; t < NT; t++) for (const d of workingDays) {
      const m = dayMetrics(itemsOf(tDay[t * D + d - 1], false, 0));
      const c = teacherDayCost(m, w);
      b.teacherGap += c.gap; b.teacherBuilding += c.building;
      if (tSoftCap[t] && m.lessons > tSoftCap[t]) b.overload += tSoftCapW[t] * (m.lessons - tSoftCap[t]);
    }
    for (let k = 0; k < reqPlaced.length; k++) b.spacing += reqCost(k);
    for (let k = 0; k < movable; k++) {
      const p = PL[k];
      const total = prefCost(p);
      if (p.placed && p.room >= 0) b.roomFit += roomFitCost(rooms[p.room].capacity, p.need, w);
      b.preferences += total - (p.placed && p.room >= 0 ? roomFitCost(rooms[p.room].capacity, p.need, w) : 0);
    }
    let total = 0;
    for (const k of Object.keys(b)) { b[k] = Math.round(b[k] * 100) / 100; total += b[k]; }
    return { total, breakdown: b };
  }

  // ───────────────────────── 1. CONSTRUCT ─────────────────────────
  const tStart = Date.now();
  hooks.onProgress?.({ percent: 2, phase: 'BUILD', placed: 0, total: nSessions, cost: 0 });
  const teacherLoad = new Map<number, number>();
  for (let k = 0; k < movable; k++) { const p = PL[k]; if (p.teacher >= 0) teacherLoad.set(p.teacher, (teacherLoad.get(p.teacher) ?? 0) + p.duration); }
  const difficulty = (p: Placement) =>
    p.groups.length * 50 + p.duration * 20 + (p.teacher >= 0 ? (teacherLoad.get(p.teacher) ?? 0) : 0) * 1.5 + (p.rooms.length ? 400 / (p.rooms.length + 1) : 80) + p.need / 10 + (p.parity === 3 ? 5 : 0);
  const order = Array.from({ length: movable }, (_, k) => k).sort((a, b) => difficulty(PL[b]) - difficulty(PL[a]) || a - b);
  let constructed = 0;
  const failed: Placement[] = [];
  const timeBudget = Math.max(1000, problem.params.timeLimitMs);
  const constructDeadline = tStart + timeBudget * 0.55;
  for (const k of order) {
    const p = PL[k];
    if (stopRequested() || Date.now() > constructDeadline) { failed.push(p); continue; }
    if (!commitBest(p)) failed.push(p);
    constructed++;
    if (constructed % 25 === 0) tick('CONSTRUCT', 5 + 45 * (constructed / Math.max(1, movable)));
  }
  curCost = fullCost().total;
  mark('CONSTRUCT', tStart);

  // ───────────────────────── 2. REPAIR ─────────────────────────
  const tRepair = Date.now();
  let stillFailed: Placement[] = [];
  for (let a = 0; a < failed.length; a++) {
    const p = failed[a];
    if (stopRequested()) { stillFailed.push(...failed.slice(a)); break; }
    if (!commitBest(p) && !tryEject(p, 40)) stillFailed.push(p);
    if (a % 10 === 0) tick('REPAIR', 50 + 10 * (a / Math.max(1, failed.length)));
  }
  curCost = fullCost().total;
  mark('REPAIR', tRepair);

  // ───────────────────────── 3. OPTIMIZE (simulated annealing) ─────────────────────────
  const tOpt = Date.now();
  let iterations = 0;
  const movables: Placement[] = [];
  for (let k = 0; k < movable; k++) if (PL[k].placed) movables.push(PL[k]);
  const optEnd = tStart + timeBudget;
  const maxIt = problem.params.maxIterations;
  if (movables.length > 1 && Date.now() < optEnd && !stopRequested()) {
    // температура: средний |delta| случайных допустимых ходов
    const sample = (): number => {
      const p = movables[Math.floor(rnd() * movables.length)];
      const d = orderedDays[Math.floor(rnd() * orderedDays.length)];
      if (!p.starts.length) return NaN;
      const sp = Math.floor(rnd() * p.starts.length);
      const st = p.starts[sp];
      const old = { d: p.day, sp: p.startPos, room: p.room };
      const days = d === old.d ? [d] : [old.d, d];
      const before = costAround([p], days);
      applyRemove(p);
      let delta = NaN;
      if (timeCode(p, d, st) === 0) {
        const room = p.needsRoom ? pickRoom(p, d, st) : -1;
        if (room >= 0 || !p.needsRoom) { applyPlace(p, d, sp, room); delta = costAround([p], days) - before; applyRemove(p); }
      }
      applyPlace(p, old.d, old.sp, old.room);
      return delta;
    };
    let sum = 0, n = 0;
    for (let i = 0; i < 300; i++) { const x = sample(); if (!Number.isNaN(x)) { sum += Math.abs(x); n++; } }
    const T0 = Math.max(0.5, n ? sum / n : 1);
    const T1 = T0 * 0.003;
    const optStart = Date.now();
    const optSpan = Math.max(1, optEnd - optStart);
    let T = T0;
    while (true) {
      if ((iterations & 255) === 0) {
        const now = Date.now();
        if (now >= optEnd || stopRequested() || (maxIt && iterations >= maxIt)) break;
        const frac = maxIt ? Math.max(iterations / maxIt, (now - optStart) / optSpan) : (now - optStart) / optSpan;
        T = T0 * Math.pow(T1 / T0, Math.min(1, frac));
        tick('OPTIMIZE', 60 + 38 * Math.min(1, frac));
      }
      iterations++;
      const p = movables[Math.floor(rnd() * movables.length)];
      if (!p.starts.length) continue;
      const mv = rnd();
      if (mv < 0.2 && p.needsRoom && p.rooms.length > 1) {
        // смена аудитории
        const r = p.rooms[Math.floor(rnd() * p.rooms.length)];
        if (r === p.room) continue;
        const st = p.starts[p.startPos];
        const before = costAround([p], [p.day]);
        const dd = p.day, sp = p.startPos, oldRoom = p.room;
        applyRemove(p);
        if (roomFits(r, dd, st, p.parity)) {
          applyPlace(p, dd, sp, r);
          const delta = costAround([p], [dd]) - before;
          if (delta <= 0 || rnd() < Math.exp(-delta / T)) continue;
          applyRemove(p);
        }
        applyPlace(p, dd, sp, oldRoom);
      } else if (mv < 0.85) {
        // перенос
        const d = orderedDays[Math.floor(rnd() * orderedDays.length)];
        const sp = Math.floor(rnd() * p.starts.length);
        if (d === p.day && sp === p.startPos) continue;
        const st = p.starts[sp];
        const old = { d: p.day, sp: p.startPos, room: p.room };
        const days = d === old.d ? [d] : [old.d, d];
        const before = costAround([p], days);
        applyRemove(p);
        let accepted = false;
        if (timeCode(p, d, st) === 0) {
          let room = -1;
          if (p.needsRoom) {
            room = old.room >= 0 && roomFits(old.room, d, st, p.parity) ? old.room : pickRoom(p, d, st);
            if (room < 0) { applyPlace(p, old.d, old.sp, old.room); continue; }
          }
          applyPlace(p, d, sp, room);
          const delta = costAround([p], days) - before;
          if (delta <= 0 || rnd() < Math.exp(-delta / T)) accepted = true;
          else applyRemove(p);
        }
        if (!accepted) applyPlace(p, old.d, old.sp, old.room);
      } else {
        // обмен позициями двух занятий
        const q = movables[Math.floor(rnd() * movables.length)];
        if (q === p || !q.starts.length || p.duration !== q.duration) continue;
        const pa = { d: p.day, sp: p.startPos, room: p.room }, qa = { d: q.day, sp: q.startPos, room: q.room };
        if (pa.d === qa.d && pa.sp === qa.sp) continue;
        const pStart = p.starts[pa.sp], qStart = q.starts[qa.sp];
        // стартовые индексы могут отличаться между разными уровнями — ищем соответствующую пару в списке партнёра
        const pPos = p.starts.findIndex((s) => s.slot === qStart.slot), qPos = q.starts.findIndex((s) => s.slot === pStart.slot);
        if (pPos < 0 || qPos < 0) continue;
        const days = Array.from(new Set([pa.d, qa.d]));
        const before = costAround([p, q], days);
        applyRemove(p); applyRemove(q);
        let ok = false;
        if (timeCode(p, qa.d, p.starts[pPos]) === 0) {
          const rp = pa.room >= 0 && roomFits(pa.room, qa.d, p.starts[pPos], p.parity) ? pa.room : (p.needsRoom ? pickRoom(p, qa.d, p.starts[pPos]) : -1);
          if (rp >= 0 || !p.needsRoom) {
            applyPlace(p, qa.d, pPos, rp);
            if (timeCode(q, pa.d, q.starts[qPos]) === 0) {
              const rq = qa.room >= 0 && roomFits(qa.room, pa.d, q.starts[qPos], q.parity) ? qa.room : (q.needsRoom ? pickRoom(q, pa.d, q.starts[qPos]) : -1);
              if (rq >= 0 || !q.needsRoom) {
                applyPlace(q, pa.d, qPos, rq);
                const delta = costAround([p, q], days) - before;
                if (delta <= 0 || rnd() < Math.exp(-delta / T)) ok = true;
                else applyRemove(q);
              }
            }
            if (!ok) applyRemove(p);
          }
        }
        if (!ok) { applyPlace(p, pa.d, pa.sp, pa.room); applyPlace(q, qa.d, qa.sp, qa.room); }
      }
    }
  }
  mark('OPTIMIZE', tOpt);

  // ───────────────────────── 4. повторная вставка ─────────────────────────
  const retry = stillFailed;
  stillFailed = [];
  for (const p of retry) {
    if (!commitBest(p) && !tryEject(p, 40)) stillFailed.push(p);
  }

  tick('FINALIZE', 99, true);
  const fc = fullCost();
  curCost = fc.total;

  const assignments: Assignment[] = [];
  for (let k = 0; k < movable; k++) {
    const p = PL[k];
    if (!p.placed) continue;
    const st = p.starts[p.startPos];
    assignments.push({ sessionId: p.session!.id, day: p.day, slotId: slots[st.slot].id, slotIds: st.slotIds, start: st.start, end: st.end, roomId: p.room >= 0 ? rooms[p.room].id : null });
  }
  const unplaced: Unplaced[] = [];
  for (let k = 0; k < movable; k++) if (!PL[k].placed) unplaced.push(diagnose(PL[k]));

  return { assignments, unplaced, cost: Math.round(fc.total * 100) / 100, breakdown: fc.breakdown, iterations, elapsedMs: Date.now() - t0, phases };
}
