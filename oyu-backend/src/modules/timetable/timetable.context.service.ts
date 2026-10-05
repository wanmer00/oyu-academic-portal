import { Injectable } from '@nestjs/common';
import { Level, PGroup, PRoom, PRule, PSlot, PTeacher, SolverParams, Weights, DEFAULT_WEIGHTS, parseTime } from './engine/types';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { Term, UserStatus } from '@prisma/client';

export interface GroupMeta {
  name: string;
  size: number;
  level: Level;
  faculty: string;
  specialty: string;
  course: number;
}

export interface TTConfig {
  workingDays: number[];
  maxConsecutive: number;
  maxDaily: number;
  longDayLimit: number;
  timeLimitSec: number;
  weights: Weights;
}

export interface LessonTypeInfo {
  code: string;
  name: string;
  roomTypes: string[];
  needsRoom: boolean;
  color: string | null;
}

export interface TTContext {
  academicYear: string;
  term: Term;
  slots: PSlot[];
  slotsAll: PSlot[];
  rooms: PRoom[];
  roomsAll: PRoom[];
  groups: PGroup[];
  groupMeta: Map<string, GroupMeta>;
  teachers: PTeacher[];
  teacherMeta: Map<string, { id: string; name: string; loginId: string; department: string }>;
  rules: PRule[];
  config: TTConfig;
  lessonTypes: Map<string, LessonTypeInfo>;
  solverParams: (seed: number, timeLimitMs: number) => SolverParams;
}

const TTL = 30_000;

/** Загрузка справочников для движка и проверок. Кэш на 30 с на период; сбрасывается при изменении настроек. */
@Injectable()
export class TimetableContextService {
  private cache = new Map<string, { at: number; ctx: TTContext }>();
  private groupCache: { at: number; list: GroupMeta[] } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  invalidate() {
    this.cache.clear();
    this.groupCache = null;
  }

  async groups(): Promise<GroupMeta[]> {
    if (this.groupCache && Date.now() - this.groupCache.at < TTL) return this.groupCache.list;
    const rows = await this.prisma.student.groupBy({
      by: ['groupName', 'faculty', 'specialty', 'level', 'course'],
      where: { user: { status: UserStatus.ACTIVE } },
      _count: { _all: true },
    });
    const byGroup = new Map<string, { size: number; top: { n: number; r: (typeof rows)[number] } }>();
    for (const r of rows) {
      const e = byGroup.get(r.groupName) ?? { size: 0, top: { n: 0, r } };
      e.size += r._count._all;
      if (r._count._all > e.top.n) e.top = { n: r._count._all, r };
      byGroup.set(r.groupName, e);
    }
    const list = Array.from(byGroup.entries())
      .map(([name, e]) => ({ name, size: e.size, level: e.top.r.level as Level, faculty: e.top.r.faculty, specialty: e.top.r.specialty, course: e.top.r.course }))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.groupCache = { at: Date.now(), list };
    return list;
  }

  async load(academicYear: string, term: Term): Promise<TTContext> {
    const key = academicYear + '|' + term;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL) return hit.ctx;

    const [slotRows, roomRows, teacherRows, ruleRows, cfg, typeRows, groupList] = await Promise.all([
      this.prisma.timeSlot.findMany({ orderBy: [{ sortOrder: 'asc' }, { startTime: 'asc' }] }),
      this.prisma.room.findMany({ orderBy: { code: 'asc' } }),
      this.prisma.teacher.findMany({ where: { user: { status: UserStatus.ACTIVE } }, select: { userId: true, department: true, user: { select: { fullName: true, loginId: true } } } }),
      this.prisma.timetableRule.findMany({ where: { OR: [{ academicYear: null }, { academicYear, term }] } }),
      this.prisma.timetableConfig.findUnique({ where: { academicYear_term: { academicYear, term } } }),
      this.prisma.lessonType.findMany({ orderBy: { sortOrder: 'asc' } }),
      this.groups(),
    ]);

    const toSlot = (s: (typeof slotRows)[number]): PSlot => ({ id: s.id, code: s.code, start: parseTime(s.startTime), end: parseTime(s.endTime), level: (s.level as Level | null) ?? null, shift: s.shift, order: s.sortOrder });
    const slotsAll = slotRows.map(toSlot);
    const slots = slotRows.filter((s) => s.isActive).map(toSlot);
    const toRoom = (r: (typeof roomRows)[number]): PRoom => ({ id: r.id, code: r.code, building: r.building, capacity: r.capacity, type: r.type, features: r.features });
    const roomsAll = roomRows.map(toRoom);
    const rooms = roomRows.filter((r) => r.isActive).map(toRoom);
    const slotCodeById = new Map(slotRows.map((s) => [s.id, s.code]));
    const rules: PRule[] = ruleRows.map((r) => ({
      id: r.id, scope: r.scope, target: r.targetId, kind: r.kind, hard: r.hard, days: r.days,
      slotCodes: r.timeSlotIds.map((id) => slotCodeById.get(id)).filter((x): x is string => !!x), value: r.value, weight: r.weight,
    }));
    const sw = (cfg?.softWeights ?? {}) as Partial<Weights>;
    const weights: Weights = { ...DEFAULT_WEIGHTS };
    for (const k of Object.keys(DEFAULT_WEIGHTS) as Array<keyof Weights>) if (typeof sw[k] === 'number') weights[k] = sw[k] as number;
    const config: TTConfig = {
      workingDays: cfg?.workingDays?.length ? cfg.workingDays : [1, 2, 3, 4, 5, 6],
      maxConsecutive: cfg?.maxConsecutive ?? 4,
      maxDaily: cfg?.maxDailyLessons ?? 5,
      longDayLimit: 6,
      timeLimitSec: cfg?.timeLimitSec ?? 60,
      weights,
    };
    const groupMeta = new Map(groupList.map((g) => [g.name, g]));
    const ctx: TTContext = {
      academicYear, term, slots, slotsAll, rooms, roomsAll,
      groups: groupList.map((g) => ({ name: g.name, size: g.size, level: g.level })),
      groupMeta,
      teachers: teacherRows.map((t) => ({ id: t.userId, name: t.user.fullName })),
      teacherMeta: new Map(teacherRows.map((t) => [t.userId, { id: t.userId, name: t.user.fullName, loginId: t.user.loginId, department: t.department }])),
      rules,
      config,
      lessonTypes: new Map(typeRows.map((t) => [t.code, { code: t.code, name: t.name, roomTypes: t.roomTypes, needsRoom: t.needsRoom, color: t.color }])),
      solverParams: (seed, timeLimitMs) => ({ seed, timeLimitMs, maxIterations: 0, maxConsecutive: config.maxConsecutive, maxDaily: config.maxDaily, longDayLimit: config.longDayLimit }),
    };
    this.cache.set(key, { at: Date.now(), ctx });
    return ctx;
  }
}
