import { Assignment, DEFAULT_WEIGHTS, Level, PGroup, PRoom, PRule, PSession, PSlot, Problem, SolverParams, parseTime, prng } from './types';
import { CLesson, CheckInput } from './checker';

/** Синтетический «университет» для тестов и бенчмарков масштаба (детерминирован по seed) */
export interface SyntheticOpts {
  seed?: number;
  bachelorGroups?: number;
  masterGroups?: number;
  groupSize?: number;
  rooms?: number;
  teachers?: number;
  /** множитель недельной нагрузки (1 ≈ 10 занятий в неделю на группу) */
  density?: number;
  timeLimitMs?: number;
  withRules?: boolean;
}

export const DEFAULT_SLOTS: PSlot[] = [
  ['B1', '08:00', '09:20', 'BACHELOR', '1'], ['B2', '09:35', '10:55', 'BACHELOR', '1'], ['B3', '11:10', '12:30', 'BACHELOR', '1'],
  ['B4', '12:45', '14:05', 'BACHELOR', '2'], ['B5', '14:20', '15:40', 'BACHELOR', '2'], ['B6', '15:55', '17:15', 'BACHELOR', '2'],
  ['M1', '17:30', '18:50', 'MASTER', 'M'], ['M2', '19:05', '20:25', 'MASTER', 'M'], ['M3', '20:40', '22:00', 'MASTER', 'M'],
].map(([code, s, e, level, shift], i) => ({ id: 'slot_' + code, code: code as string, start: parseTime(s as string), end: parseTime(e as string), level: level as Level, shift: shift as string, order: i }));

export function syntheticProblem(o: SyntheticOpts = {}): Problem {
  const rnd = prng(o.seed ?? 7);
  const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const nB = o.bachelorGroups ?? 190, nM = o.masterGroups ?? 10, size = o.groupSize ?? 25;
  const nRooms = o.rooms ?? 500, nTeachers = o.teachers ?? 350, density = o.density ?? 1;
  const groups: PGroup[] = [];
  for (let i = 0; i < nB; i++) groups.push({ name: `B-${100 + i}`, size: size + Math.floor(rnd() * 6) - 3, level: 'BACHELOR' });
  for (let i = 0; i < nM; i++) groups.push({ name: `M-${i + 1}`, size: 15, level: 'MASTER' });
  const rooms: PRoom[] = [];
  for (let i = 0; i < nRooms; i++) {
    const k = i % 25;
    const type = k < 2 ? 'lecture_hall' : k < 5 ? 'lab' : k < 7 ? 'computer_lab' : 'classroom';
    const capacity = type === 'lecture_hall' ? 60 + Math.floor(rnd() * 140) : type === 'classroom' ? 20 + Math.floor(rnd() * 25) : 20 + Math.floor(rnd() * 12);
    rooms.push({ id: 'room' + i, code: 'R' + (100 + i), building: 'K' + (1 + (i % 8)), capacity, type, features: type === 'computer_lab' ? ['computers'] : type === 'lab' ? ['lab_equipment'] : ['projector'] });
  }
  const teachers = Array.from({ length: nTeachers }, (_, i) => ({ id: 't' + i, name: 'Teacher ' + i }));
  const sessions: PSession[] = [];
  let sid = 0, rid = 0;
  const add = (groupNames: string[], level: Level, type: string, roomTypes: string[], count: number, subj: number, feats: string[] = []) => {
    const req = 'req' + rid++;
    const teacher = teachers[Math.floor(rnd() * nTeachers)].id;
    for (let i = 0; i < count; i++) sessions.push({ id: 's' + sid++, requirementId: req, index: i, subjectId: 'sub' + subj, teacherId: teacher, groups: groupNames, type, roomTypes, features: feats, parity: 3, duration: 1, level });
  };
  const scale = (n: number) => Math.max(1, Math.round(n * density));
  let subj = 0;
  for (let i = 0; i < nB; i += 2) {
    const pair = groups.slice(i, Math.min(nB, i + 2)).map((g) => g.name);
    for (let k = 0; k < 3; k++) add(pair, 'BACHELOR', 'lecture', ['lecture_hall', 'classroom'], scale(1), subj++);
  }
  for (let i = 0; i < nB; i++) {
    const g = [groups[i].name];
    for (let k = 0; k < 4; k++) add(g, 'BACHELOR', 'seminar', ['classroom', 'lecture_hall'], scale(1), subj++);
    for (let k = 0; k < 2; k++) add(g, 'BACHELOR', 'lab', ['lab', 'computer_lab'], scale(1), subj++);
    add(g, 'BACHELOR', 'practice', ['classroom', 'lab', 'computer_lab'], scale(1), subj++);
  }
  for (let i = nB; i < nB + nM; i++) for (let k = 0; k < 6; k++) add([groups[i].name], 'MASTER', k % 3 === 0 ? 'lecture' : 'seminar', ['classroom', 'lecture_hall'], scale(1), subj++);

  const rules: PRule[] = [];
  if (o.withRules !== false) {
    for (const t of teachers) {
      const x = rnd();
      if (x < 0.1) rules.push({ scope: 'TEACHER', target: t.id, kind: 'UNAVAILABLE', hard: true, days: [pick([1, 2, 3, 4, 5, 6])], slotCodes: [], value: null, weight: 1 });
      else if (x < 0.35) rules.push({ scope: 'TEACHER', target: t.id, kind: 'UNAVAILABLE', hard: false, days: [], slotCodes: ['B1'], value: null, weight: 2 });
      else if (x < 0.5) rules.push({ scope: 'TEACHER', target: t.id, kind: 'PREFERRED', hard: false, days: [], slotCodes: ['B2', 'B3'], value: null, weight: 1 });
    }
    for (const g of groups.slice(0, Math.floor(groups.length * 0.3))) if (g.level === 'BACHELOR') rules.push({ scope: 'GROUP', target: g.name, kind: 'NO_LATE', hard: false, days: [], slotCodes: [], value: { fromOrder: 5 }, weight: 2 });
  }
  const params: SolverParams = { seed: o.seed ?? 7, timeLimitMs: o.timeLimitMs ?? 8000, maxIterations: 0, maxConsecutive: 4, maxDaily: 5, longDayLimit: 6 };
  return { days: [1, 2, 3, 4, 5, 6], slots: DEFAULT_SLOTS, rooms, teachers, groups, rules, sessions, fixed: [], weights: DEFAULT_WEIGHTS, params };
}

/** Результат солвера → вход Conflict Checker (для независимой проверки) */
export function toCheckInput(p: Problem, assignments: Assignment[]): CheckInput {
  const bySession = new Map(p.sessions.map((s) => [s.id, s]));
  const lessons: CLesson[] = assignments.map((a) => {
    const s = bySession.get(a.sessionId)!;
    return { id: a.sessionId, requirementId: s.requirementId, subjectId: s.subjectId, teacherId: s.teacherId, roomId: a.roomId, groups: s.groups, type: s.type, day: a.day, start: a.start, end: a.end, parity: s.parity, level: s.level };
  });
  for (const f of p.fixed) lessons.push({ id: f.id, requirementId: f.requirementId ?? null, subjectId: f.subjectId, teacherId: f.teacherId, roomId: f.roomId, groups: f.groups, type: 'lecture', day: f.day, start: f.start, end: f.end, parity: f.parity, level: 'BACHELOR' });
  const reqMap = new Map<string, { id: string; subjectId: string; teacherId: string | null; groups: string[]; type: string; sessionsPerWeek: number }>();
  for (const s of p.sessions) {
    const r = reqMap.get(s.requirementId);
    if (r) r.sessionsPerWeek++;
    else reqMap.set(s.requirementId, { id: s.requirementId, subjectId: s.subjectId, teacherId: s.teacherId, groups: s.groups, type: s.type, sessionsPerWeek: 1 });
  }
  const lessonTypeRooms: Record<string, string[]> = {};
  for (const s of p.sessions) lessonTypeRooms[s.type] = s.roomTypes;
  return {
    lessons, rooms: p.rooms, groups: p.groups, slots: p.slots, rules: p.rules, workingDays: p.days,
    requirements: Array.from(reqMap.values()).map((r) => ({ ...r, isActive: true })), lessonTypeRooms, roomlessTypes: [], weights: p.weights, params: p.params,
  };
}
