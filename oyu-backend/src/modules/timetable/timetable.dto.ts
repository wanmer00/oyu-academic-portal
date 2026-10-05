import { StudyLevel, Term, TimetableRuleKind, TimetableRuleScope, TimetableStatus, WeekParity } from '@prisma/client';
import { z } from 'zod';

const id = z.string().min(1).max(40);
const year = z.string().regex(/^\d{4}-\d{4}$/, 'YYYY-YYYY');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
const day = z.number().int().min(1).max(7);
const code = z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9_.-]+$/);
const take = (def: number, max: number) => z.coerce.number().int().min(1).max(max).default(def);
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const csvList = z.string().max(400).transform((v) => v.split(',').map((x) => x.trim()).filter(Boolean));

export const PeriodQuery = z.object({ academicYear: year, term: z.nativeEnum(Term) });

// ── справочники ──
export const TimeSlotSchema = z
  .object({ code, label: z.string().trim().min(1).max(30), startTime: time, endTime: time, level: z.nativeEnum(StudyLevel).nullable().optional(), shift: z.string().trim().max(20).nullable().optional(), sortOrder: z.number().int().min(0).max(999).optional(), isActive: z.boolean().optional() })
  .strict()
  .refine((d) => d.startTime < d.endTime, 'startTime must be before endTime');
export const TimeSlotPatchSchema = z
  .object({ label: z.string().trim().min(1).max(30), startTime: time, endTime: time, level: z.nativeEnum(StudyLevel).nullable(), shift: z.string().trim().max(20).nullable(), sortOrder: z.number().int().min(0).max(999), isActive: z.boolean() })
  .partial()
  .strict();

export const LessonTypeSchema = z
  .object({ code, name: z.string().trim().min(1).max(60), roomTypes: z.array(z.string().trim().min(1).max(30)).max(10).default([]), needsRoom: z.boolean().default(true), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(), sortOrder: z.number().int().min(0).max(999).optional(), isActive: z.boolean().optional() })
  .strict();
export const LessonTypePatchSchema = LessonTypeSchema.omit({ code: true }).partial().strict();

export const ConfigPatchSchema = z
  .object({
    workingDays: z.array(day).min(1).max(7),
    maxConsecutive: z.number().int().min(1).max(10),
    maxDailyLessons: z.number().int().min(1).max(12),
    timeLimitSec: z.number().int().min(5).max(1800),
    softWeights: z.record(z.string().max(30), z.number().min(0).max(100)),
  })
  .partial()
  .strict();

export const RuleSchema = z
  .object({
    scope: z.nativeEnum(TimetableRuleScope),
    targetId: z.string().trim().min(1).max(60).nullable().optional(),
    kind: z.nativeEnum(TimetableRuleKind),
    hard: z.boolean().default(false),
    days: z.array(day).max(7).default([]),
    timeSlotIds: z.array(id).max(30).default([]),
    value: z.record(z.any()).nullable().optional(),
    weight: z.number().int().min(1).max(20).default(1),
    note: z.string().trim().max(300).nullable().optional(),
    academicYear: year.nullable().optional(),
    term: z.nativeEnum(Term).nullable().optional(),
  })
  .strict()
  .refine((r) => r.scope === 'GLOBAL' || !!r.targetId, { message: 'targetId is required', path: ['targetId'] });
export const RulesQuery = z.object({ scope: z.nativeEnum(TimetableRuleScope).optional(), targetId: z.string().max(60).optional(), kind: z.nativeEnum(TimetableRuleKind).optional(), take: take(100, 500), page: take(1, 100000) });

export const MyAvailabilitySchema = z
  .object({ rules: z.array(z.object({ kind: z.enum(['UNAVAILABLE', 'PREFERRED']), days: z.array(day).max(7).default([]), timeSlotIds: z.array(id).max(30).default([]), note: z.string().trim().max(200).nullable().optional() }).strict()).max(40) })
  .strict();

// ── нагрузка ──
export const RequirementSchema = z
  .object({
    academicYear: year,
    term: z.nativeEnum(Term),
    subjectId: id,
    groupNames: z.array(z.string().trim().min(1).max(50)).min(1).max(12),
    teacherId: id.nullable().optional(),
    lessonTypeCode: code,
    sessionsPerWeek: z.number().int().min(1).max(14).default(1),
    durationSlots: z.number().int().min(1).max(3).default(1),
    weekParity: z.nativeEnum(WeekParity).default('BOTH'),
    roomType: z.string().trim().max(30).nullable().optional(),
    requiredFeatures: z.array(z.string().trim().min(1).max(30)).max(10).default([]),
    isActive: z.boolean().default(true),
    note: z.string().trim().max(300).nullable().optional(),
  })
  .strict();
export const RequirementPatchSchema = RequirementSchema.omit({ academicYear: true, term: true }).partial().strict();
export const RequirementsQuery = PeriodQuery.extend({
  search: z.string().trim().max(80).optional(),
  group: z.string().max(50).optional(),
  teacherId: id.optional(),
  subjectId: id.optional(),
  type: z.string().max(30).optional(),
  page: take(1, 100000),
  pageSize: take(50, 200),
});
export const BuildRequirementsSchema = z
  .object({
    academicYear: year,
    term: z.nativeEnum(Term),
    faculty: z.string().max(120).optional(),
    level: z.nativeEnum(StudyLevel).optional(),
    groups: z.array(z.string().max(50)).max(500).optional(),
    pattern: z.array(z.object({ lessonTypeCode: code, sessionsPerWeek: z.number().int().min(1).max(7), durationSlots: z.number().int().min(1).max(3).default(1) }).strict()).min(1).max(5).default([{ lessonTypeCode: 'lecture', sessionsPerWeek: 1, durationSlots: 1 }, { lessonTypeCode: 'seminar', sessionsPerWeek: 1, durationSlots: 1 }]),
    replace: z.boolean().default(false),
    /** лекции объединяются в потоки по N групп одной специальности и курса (1 — без потоков) */
    streamLectures: z.number().int().min(1).max(8).default(1),
  })
  .strict();
export const ImportRequirementsSchema = z
  .object({
    academicYear: year,
    term: z.nativeEnum(Term),
    dryRun: z.boolean().default(true),
    rows: z
      .array(z.object({ subjectCode: z.string().trim().min(1).max(20), groups: z.string().trim().min(1).max(300), teacherLoginId: z.string().trim().max(20).optional(), lessonType: z.string().trim().min(1).max(30), sessionsPerWeek: z.coerce.number().int().min(1).max(14).default(1), durationSlots: z.coerce.number().int().min(1).max(3).default(1), parity: z.string().trim().max(10).optional(), roomType: z.string().trim().max(30).optional() }).strict())
      .min(1)
      .max(3000),
  })
  .strict();

// ── версии и занятия ──
export const VersionsQuery = PeriodQuery.partial().extend({ status: z.nativeEnum(TimetableStatus).optional() });
export const CreateVersionSchema = z.object({ academicYear: year, term: z.nativeEnum(Term), fromVersionId: id.nullable().optional(), name: z.string().trim().max(80).optional(), note: z.string().trim().max(500).optional() }).strict();
export const VersionPatchSchema = z.object({ name: z.string().trim().max(80).nullable().optional(), note: z.string().trim().max(500).nullable().optional() }).strict();
export const ReasonSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
export const OptionalNote = z.object({ note: z.string().trim().max(500).optional() }).strict();

export const LessonsQuery = z.object({
  search: z.string().trim().max(80).optional(),
  faculty: z.string().max(120).optional(),
  specialty: z.string().max(120).optional(),
  level: z.nativeEnum(StudyLevel).optional(),
  group: z.string().max(50).optional(),
  teacherId: id.optional(),
  subjectId: id.optional(),
  roomId: id.optional(),
  building: z.string().max(60).optional(),
  day: z.coerce.number().int().min(1).max(7).optional(),
  type: z.string().max(30).optional(),
  timeSlotId: id.optional(),
  fromTime: time.optional(),
  toTime: time.optional(),
  locked: bool.optional(),
  page: take(1, 100000),
  pageSize: take(50, 500),
});
export const CalendarQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  group: z.string().max(50).optional(),
  teacherId: id.optional(),
  roomId: id.optional(),
  faculty: z.string().max(120).optional(),
});

const lessonBody = {
  subjectId: id,
  teacherId: id.nullable().optional(),
  roomId: id.nullable().optional(),
  groupNames: z.array(z.string().trim().min(1).max(50)).min(1).max(12),
  lessonTypeCode: code,
  dayOfWeek: day,
  timeSlotId: id.nullable().optional(),
  startTime: time.optional(),
  endTime: time.optional(),
  weekParity: z.nativeEnum(WeekParity).default('BOTH'),
  requirementId: id.nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
};
const timeRule = (d: { timeSlotId?: string | null; startTime?: string; endTime?: string }) => !!d.timeSlotId || (!!d.startTime && !!d.endTime && d.startTime < d.endTime);
export const CreateLessonSchema = z
  .object({ ...lessonBody, overrideReason: z.string().trim().min(3).max(500).optional() })
  .strict()
  .refine(timeRule, { message: 'timeSlotId or startTime/endTime required', path: ['timeSlotId'] });
export const UpdateLessonSchema = z
  .object({
    subjectId: lessonBody.subjectId, teacherId: lessonBody.teacherId, roomId: lessonBody.roomId, groupNames: lessonBody.groupNames, lessonTypeCode: lessonBody.lessonTypeCode,
    dayOfWeek: lessonBody.dayOfWeek, timeSlotId: lessonBody.timeSlotId, startTime: lessonBody.startTime, endTime: lessonBody.endTime, weekParity: z.nativeEnum(WeekParity), note: lessonBody.note,
    locked: z.boolean(), overrideReason: z.string().trim().min(3).max(500),
  })
  .partial()
  .strict();
export const BulkLockSchema = z.object({ ids: z.array(id).min(1).max(2000), locked: z.boolean() }).strict();

// ── генерация ──
export const GenerateSchema = z
  .object({
    academicYear: year,
    term: z.nativeEnum(Term),
    baseVersionId: id.nullable().optional(),
    mode: z.enum(['FRESH', 'REGENERATE']).default('FRESH'),
    scope: z
      .object({
        levels: z.array(z.nativeEnum(StudyLevel)).max(3).optional(),
        faculties: z.array(z.string().max(120)).max(50).optional(),
        specialties: z.array(z.string().max(120)).max(100).optional(),
        groups: z.array(z.string().max(50)).max(1000).optional(),
        subjects: z.array(id).max(500).optional(),
        teachers: z.array(id).max(500).optional(),
        rooms: z.array(id).max(1000).optional(),
        days: z.array(day).max(7).optional(),
        slotIds: z.array(id).max(30).optional(),
        /** точечная перегенерация указанных занятий (например, затронутых конфликтом) */
        lessonIds: z.array(id).max(2000).optional(),
      })
      .strict()
      .default({}),
    timeLimitSec: z.number().int().min(5).max(1800).optional(),
    seed: z.number().int().min(1).max(2_000_000_000).optional(),
    note: z.string().trim().max(300).optional(),
  })
  .strict();

export const ConflictsQuery = z.object({ severity: z.enum(['critical', 'warning']).optional(), code: z.string().max(40).optional(), take: take(200, 2000), refresh: bool.optional() });

export const ExportQuery = z.object({
  format: z.enum(['csv', 'xlsx']).default('xlsx'),
  by: z.enum(['all', 'group', 'teacher', 'room', 'faculty', 'day']).default('all'),
  value: z.string().max(120).optional(),
  day: z.coerce.number().int().min(1).max(7).optional(),
  lang: z.enum(['az', 'ru', 'en']).optional(),
});

export type GenerateDto = z.infer<typeof GenerateSchema>;
export type CreateLessonDto = z.infer<typeof CreateLessonSchema>;
export type UpdateLessonDto = z.infer<typeof UpdateLessonSchema>;
export type RequirementDto = z.infer<typeof RequirementSchema>;
export type LessonsQueryDto = z.infer<typeof LessonsQuery>;
export { csvList };
