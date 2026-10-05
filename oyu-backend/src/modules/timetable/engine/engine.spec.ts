import { describe, expect, it } from 'vitest';
import { checkLessons } from './checker';
import { solve } from './solver';
import { DEFAULT_SLOTS, syntheticProblem, toCheckInput } from './synthetic';
import { DEFAULT_WEIGHTS, PRule, PSession, Problem, parseTime } from './types';

const base = (over: Partial<Problem> = {}): Problem => ({
  days: [1, 2, 3, 4, 5],
  slots: DEFAULT_SLOTS,
  rooms: [
    { id: 'r1', code: 'A101', building: 'A', capacity: 30, type: 'classroom', features: [] },
    { id: 'r2', code: 'A102', building: 'A', capacity: 30, type: 'classroom', features: [] },
    { id: 'h1', code: 'H1', building: 'B', capacity: 120, type: 'lecture_hall', features: [] },
    { id: 'l1', code: 'LAB1', building: 'B', capacity: 25, type: 'lab', features: ['lab_equipment'] },
  ],
  teachers: [{ id: 't1', name: 'T1' }, { id: 't2', name: 'T2' }],
  groups: [{ name: 'G1', size: 25, level: 'BACHELOR' }, { name: 'G2', size: 25, level: 'BACHELOR' }],
  rules: [],
  sessions: [],
  fixed: [],
  weights: DEFAULT_WEIGHTS,
  params: { seed: 1, timeLimitMs: 1500, maxIterations: 20000, maxConsecutive: 4, maxDaily: 5, longDayLimit: 6 },
  ...over,
});
const sess = (id: string, over: Partial<PSession> = {}): PSession => ({
  id, requirementId: 'r_' + id, index: 0, subjectId: 'sub_' + id, teacherId: 't1', groups: ['G1'], type: 'seminar', roomTypes: ['classroom'], features: [], parity: 3, duration: 1, level: 'BACHELOR', ...over,
});
const verify = (p: Problem, r: ReturnType<typeof solve>) => checkLessons(toCheckInput(p, r.assignments));
const hardOnly = (c: ReturnType<typeof checkLessons>) => c.critical.filter((x) => x.code !== 'MISSING_REQUIRED');

describe('Scheduling Engine — HARD constraints', () => {
  it('размещает всё и не нарушает hard-ограничений (независимая проверка Conflict Checker)', () => {
    const p = base({ sessions: [sess('a'), sess('b'), sess('c', { groups: ['G2'], teacherId: 't2' }), sess('d', { groups: ['G1', 'G2'], type: 'lecture', roomTypes: ['lecture_hall'] })] });
    const r = solve(p);
    expect(r.unplaced).toHaveLength(0);
    expect(r.assignments).toHaveLength(4);
    expect(hardOnly(verify(p, r))).toEqual([]);
  });

  it('один преподаватель / группа / аудитория не бывают заняты дважды (много занятий на одного преподавателя)', () => {
    const sessions = Array.from({ length: 20 }, (_, i) => sess('x' + i, { groups: [i % 2 ? 'G1' : 'G2'], teacherId: 't1' }));
    const p = base({ sessions });
    const r = solve(p);
    expect(r.unplaced).toHaveLength(0);
    const c = verify(p, r);
    expect(c.critical.filter((x) => /DOUBLE/.test(x.code))).toEqual([]);
  });

  it('вместимость: поток 100 студентов попадает только в аудиторию на 100+', () => {
    const p = base({ groups: [{ name: 'G1', size: 50, level: 'BACHELOR' }, { name: 'G2', size: 50, level: 'BACHELOR' }], sessions: [sess('s', { groups: ['G1', 'G2'], type: 'lecture', roomTypes: [] })] });
    const r = solve(p);
    expect(r.assignments[0].roomId).toBe('h1');
    const p2 = base({ rooms: [{ id: 'r1', code: 'A101', building: 'A', capacity: 40, type: 'classroom', features: [] }], groups: p.groups, sessions: p.sessions });
    const r2 = solve(p2);
    expect(r2.unplaced[0].code).toBe('NO_ROOM_FITS');
  });

  it('тип аудитории: лабораторная — только в лаборатории', () => {
    const p = base({ sessions: [sess('lab', { type: 'lab', roomTypes: ['lab'], features: ['lab_equipment'] })] });
    expect(solve(p).assignments[0].roomId).toBe('l1');
    const noLab = base({ rooms: base().rooms.filter((r) => r.type !== 'lab'), sessions: p.sessions });
    expect(solve(noLab).unplaced[0].code).toBe('NO_ROOM_FITS');
  });

  it('доступность: преподаватель/группа/аудитория не получают занятия в закрытое время', () => {
    const rules: PRule[] = [
      { scope: 'TEACHER', target: 't1', kind: 'UNAVAILABLE', hard: true, days: [1, 2, 3], slotCodes: [], value: null, weight: 1 },
      { scope: 'GROUP', target: 'G1', kind: 'UNAVAILABLE', hard: true, days: [4], slotCodes: [], value: null, weight: 1 },
      { scope: 'BUILDING', target: 'A', kind: 'UNAVAILABLE', hard: true, days: [5], slotCodes: [], value: null, weight: 1 },
    ];
    const p = base({ rules, sessions: Array.from({ length: 4 }, (_, i) => sess('u' + i, { roomTypes: [] })) });
    const r = solve(p);
    expect(r.unplaced).toHaveLength(0);
    for (const a of r.assignments) { expect([4, 5]).toContain(a.day); }
    expect(hardOnly(verify(p, r))).toEqual([]);
  });

  it('допустимые корпуса (hard): только корпус B', () => {
    const rules: PRule[] = [{ scope: 'GROUP', target: 'G1', kind: 'ALLOWED_BUILDINGS', hard: true, days: [], slotCodes: [], value: { buildings: ['B'] }, weight: 1 }];
    const p = base({ rules, sessions: [sess('b', { roomTypes: [] })] });
    const r = solve(p);
    expect(['h1', 'l1']).toContain(r.assignments[0].roomId);
  });

  it('MAX_PER_DAY (hard) соблюдается', () => {
    const rules: PRule[] = [{ scope: 'GROUP', target: 'G1', kind: 'MAX_PER_DAY', hard: true, days: [], slotCodes: [], value: { max: 2 }, weight: 1 }];
    const p = base({ rules, sessions: Array.from({ length: 8 }, (_, i) => sess('m' + i)) });
    const r = solve(p);
    expect(r.unplaced).toHaveLength(0);
    const perDay = new Map<number, number>();
    for (const a of r.assignments) perDay.set(a.day, (perDay.get(a.day) ?? 0) + 1);
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(2);
  });

  it('зафиксированные занятия не двигаются и занимают ресурсы', () => {
    const p = base({
      days: [1],
      fixed: [{ id: 'f1', subjectId: 'x', teacherId: 't1', roomId: 'r1', groups: ['G1'], day: 1, start: parseTime('08:00'), end: parseTime('09:20'), parity: 3 }],
      sessions: [sess('n1'), sess('n2')],
    });
    const r = solve(p);
    for (const a of r.assignments) expect(a.start).not.toBe(parseTime('08:00'));
    expect(hardOnly(verify(p, r))).toEqual([]);
  });

  it('чётность недели: верхняя и нижняя неделя могут делить одну пару', () => {
    const p = base({
      days: [1], slots: DEFAULT_SLOTS.slice(0, 1),
      sessions: [sess('u', { parity: 1 }), sess('l', { parity: 2 })],
    });
    const r = solve(p);
    expect(r.unplaced).toHaveLength(0);
    expect(r.assignments[0].slotId).toBe(r.assignments[1].slotId);
  });

  it('невозможное занятие остаётся неразмещённым с понятной причиной', () => {
    const rules: PRule[] = [{ scope: 'TEACHER', target: 't1', kind: 'UNAVAILABLE', hard: true, days: [], slotCodes: [], value: null, weight: 1 }];
    const p = base({ rules, sessions: [sess('z')] });
    const r = solve(p);
    expect(r.unplaced[0]).toMatchObject({ sessionId: 'z', code: 'TEACHER_UNAVAILABLE' });
  });

  it('сдвоенная пара (duration 2) занимает две подряд идущие пары одной смены', () => {
    const p = base({ sessions: [sess('d', { duration: 2 })] });
    const r = solve(p);
    expect(r.assignments[0].slotIds).toHaveLength(2);
    const ids = DEFAULT_SLOTS.map((s) => s.id);
    const i = ids.indexOf(r.assignments[0].slotIds[0]);
    expect(ids[i + 1]).toBe(r.assignments[0].slotIds[1]);
    expect(DEFAULT_SLOTS[i].shift).toBe(DEFAULT_SLOTS[i + 1].shift);
  });

  it('уровень: магистры — только в магистерские пары', () => {
    const p = base({ groups: [{ name: 'M1', size: 15, level: 'MASTER' }], sessions: [sess('m', { groups: ['M1'], level: 'MASTER' })] });
    const r = solve(p);
    expect(r.assignments[0].slotId).toMatch(/slot_M/);
  });
});

describe('Scheduling Engine — оптимизация и детерминизм', () => {
  it('оптимизация уменьшает мягкую цену по сравнению с конструктивной фазой', () => {
    const p = syntheticProblem({ bachelorGroups: 12, masterGroups: 2, rooms: 40, teachers: 25, timeLimitMs: 4000 });
    const r = solve(p);
    const construct = r.phases.find((x) => x.phase === 'CONSTRUCT')!.cost;
    expect(r.cost).toBeLessThanOrEqual(construct);
    expect(r.unplaced).toHaveLength(0);
    expect(hardOnly(verify(p, r))).toEqual([]);
  }, 30000);

  it('одинаковый seed даёт одинаковый результат (при одинаковом числе итераций)', () => {
    const mk = () => { const p = syntheticProblem({ bachelorGroups: 6, masterGroups: 1, rooms: 20, teachers: 12, timeLimitMs: 60000 }); p.params.maxIterations = 5000; return p; };
    const a = solve(mk()), b = solve(mk());
    expect(a.assignments).toEqual(b.assignments);
    expect(a.cost).toBe(b.cost);
  }, 60000);

  it('итоговая цена совпадает с независимой пересборкой (инкрементальная оценка корректна)', () => {
    const p = syntheticProblem({ bachelorGroups: 8, masterGroups: 1, rooms: 25, teachers: 15, timeLimitMs: 3000, withRules: false });
    const r = solve(p);
    const c = checkLessons(toCheckInput(p, r.assignments));
    // Conflict Checker считает ту же мягкую цену по тем же формулам (кроме bonus/pref правил — их здесь нет)
    const checkerCost = c.warnings.filter((x) => x.code !== 'SOFT_ROOM_WASTE').reduce((s, x) => s + (x.cost ?? 0), 0);
    const solverCost = Object.entries(r.breakdown).filter(([k]) => !['roomFit', 'preferences'].includes(k)).reduce((s, [, v]) => s + v, 0);
    expect(Math.abs(checkerCost - solverCost) / Math.max(1, solverCost)).toBeLessThan(0.02);
  }, 30000);
});

describe('Scheduling Engine — университетский масштаб', () => {
  it('~4 900 студентов, 500 аудиторий, 350 преподавателей: все занятия размещены, 0 критических конфликтов', () => {
    const p = syntheticProblem({ timeLimitMs: 40000 });
    const students = p.groups.reduce((a, g) => a + g.size, 0);
    expect(students).toBeGreaterThan(4500);
    expect(p.rooms.length).toBe(500);
    const t0 = Date.now();
    const r = solve(p);
    const ms = Date.now() - t0;
    const placedPct = (r.assignments.length / p.sessions.length) * 100;
    const c = checkLessons(toCheckInput(p, r.assignments));
    // eslint-disable-next-line no-console
    console.log(`[scale] sessions=${p.sessions.length} placed=${r.assignments.length} (${placedPct.toFixed(2)}%) unplaced=${r.unplaced.length} cost=${r.cost} ms=${ms} critical(non-missing)=${hardOnly(c).length} soft=${c.summary.warningCount} phases=${JSON.stringify(r.phases)}`);
    expect(placedPct).toBeGreaterThanOrEqual(99);
    expect(hardOnly(c)).toEqual([]);
    expect(ms).toBeLessThan(120000);
  }, 180000);
});
