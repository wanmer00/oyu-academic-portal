import { Prisma, WeekParity } from '@prisma/client';
import { CLesson, CRequirement, CheckInput } from './engine/checker';
import { Level, PARITY_BITS, ParityMask, fmtTime, parseTime } from './engine/types';
import { TTContext } from './timetable.context.service';

export const hhmm = (m: number) => fmtTime(m);

export type LessonRow = Prisma.ScheduleLessonGetPayload<Record<string, never>>;
export type RequirementRow = Prisma.LessonRequirementGetPayload<Record<string, never>>;

export const toCLesson = (r: LessonRow): CLesson => ({
  id: r.id, requirementId: r.requirementId, subjectId: r.subjectId, teacherId: r.teacherId, roomId: r.roomId, groups: r.groupNames, type: r.lessonTypeCode,
  day: r.dayOfWeek, start: parseTime(r.startTime), end: parseTime(r.endTime), parity: (PARITY_BITS[r.weekParity] ?? 3) as ParityMask, level: r.level as Level,
});

export const toCRequirement = (r: RequirementRow): CRequirement => ({
  id: r.id, subjectId: r.subjectId, teacherId: r.teacherId, groups: r.groupNames, type: r.lessonTypeCode, sessionsPerWeek: r.sessionsPerWeek,
  roomType: r.roomType, features: r.requiredFeatures, isActive: r.isActive,
});

export function checkInputFor(ctx: TTContext, lessons: CLesson[], requirements: CRequirement[]): CheckInput {
  const lessonTypeRooms: Record<string, string[]> = {};
  const roomless: string[] = [];
  for (const t of ctx.lessonTypes.values()) { lessonTypeRooms[t.code] = t.roomTypes; if (!t.needsRoom) roomless.push(t.code); }
  return {
    lessons, rooms: ctx.roomsAll, groups: ctx.groups, slots: ctx.slotsAll, rules: ctx.rules, workingDays: ctx.config.workingDays, requirements,
    lessonTypeRooms, roomlessTypes: roomless, weights: ctx.config.weights,
    params: { maxConsecutive: ctx.config.maxConsecutive, maxDaily: ctx.config.maxDaily, longDayLimit: ctx.config.longDayLimit },
  };
}

export const parityName = (m: number): WeekParity => (m === 1 ? 'UPPER' : m === 2 ? 'LOWER' : 'BOTH');

/** Определяет уровень занятия по уровню первой группы (потоки — одного уровня) */
export const levelOfGroups = (ctx: TTContext, groups: string[]): Level => ctx.groupMeta.get(groups[0])?.level ?? 'BACHELOR';

/** Пара сетки, в точности совпадающая с интервалом (или null — индивидуальный интервал) */
export const slotFor = (ctx: TTContext, start: number, end: number, level: Level) =>
  ctx.slotsAll.find((s) => s.start === start && s.end === end && (s.level === null || s.level === level)) ?? ctx.slotsAll.find((s) => s.start === start && s.end === end) ?? null;
