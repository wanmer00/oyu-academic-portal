import { AttendanceStatus, Term } from '@prisma/client';
import { z } from 'zod';
import { JOURNAL_RULES } from './journal.calc';

// ── Примитивы ──
const id = z.string().min(1).max(40);
const twoDecimals = (v: number) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
/** Балл 0..max, не более 2 знаков после запятой. Границы проверяются и в сервисе (defence in depth). */
export const scoreOf = (max: number) =>
  z.number({ invalid_type_error: 'score must be a number' }).finite().min(0).max(max).refine(twoDecimals, 'At most 2 decimal places');

export const seminarScore = scoreOf(JOURNAL_RULES.SEMINAR_ANSWER_MAX);
export const midtermScore = scoreOf(JOURNAL_RULES.MIDTERM_MAX);
export const finalScore = scoreOf(JOURNAL_RULES.FINAL_MAX);

const academicYear = z.string().regex(/^\d{4}-\d{4}$/, 'Expected YYYY-YYYY');
const term = z.nativeEnum(Term);
const reason = z.string().trim().min(3).max(500);
const optionalReason = z.string().trim().max(500).optional();
const comment = z.string().trim().max(500).optional();

const periodFields = { academicYear, term };
const optPeriod = { academicYear: academicYear.optional(), term: term.optional() };

// ── Query ──
const num = (def: number, min: number, max: number) =>
  z.preprocess((v) => (v === undefined || v === '' ? def : Number(v)), z.number().int().min(min).max(max));

export const RecordsQuerySchema = z.object({
  ...optPeriod,
  subjectId: id.optional(),
  groupName: z.string().trim().min(1).max(50).optional(),
  teacherId: id.optional(),
  faculty: z.string().trim().min(1).max(120).optional(),
  department: z.string().trim().min(1).max(120).optional(),
  status: z.enum(['PROVISIONAL', 'READY', 'PUBLISHED', 'LOCKED']).optional(),
  search: z.string().trim().max(80).optional(),
  page: num(1, 1, 100000),
  pageSize: num(25, 1, 100),
});
export type RecordsQuery = z.infer<typeof RecordsQuerySchema>;

export const PeriodQuerySchema = z.object({ ...optPeriod });
export type PeriodQuery = z.infer<typeof PeriodQuerySchema>;

/** Личный журнал: studentId нужен сотрудникам; студент видит только себя */
export const MeQuerySchema = z.object({ ...optPeriod, studentId: id.optional() });

export const CompareQuerySchema = z.object({
  ...optPeriod,
  groups: z.string().trim().min(1).max(400), // "CS-401,CS-402"
  subjectId: id.optional(),
});

export const DetailQuerySchema = z.object({ ...optPeriod });

export const AuditQuerySchema = z.object({
  category: z.enum(['grade', 'seminar', 'attendance', 'publish', 'period', 'export']).optional(),
  actor: z.string().trim().max(60).optional(),
  student: z.string().trim().max(60).optional(),
  subject: z.string().trim().max(20).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: num(1, 1, 100000),
  pageSize: num(25, 1, 100),
});

// ── Write ──
export const AddSeminarSchema = z
  .object({ studentId: id, subjectId: id, ...periodFields, score: seminarScore, comment })
  .strict();

export const SetComponentSchema = z
  .object({
    studentId: id,
    subjectId: id,
    ...periodFields,
    type: z.enum(['MIDTERM', 'FINAL']),
    score: z.number().finite(),
    reason: optionalReason,
  })
  .strict();

export const UpdateGradeSchema = z
  .object({ score: z.number().finite().optional(), comment: z.string().trim().max(500).optional(), reason: optionalReason })
  .strict()
  .refine((v) => v.score !== undefined || v.comment !== undefined, 'Nothing to update');

export const DeleteGradeSchema = z.object({ reason: optionalReason }).strict();

const context = { subjectId: id, groupName: z.string().trim().min(1).max(50), ...periodFields };

export const PublishSchema = z
  .object({ ...context, studentIds: z.array(id).min(1).max(300).optional() })
  .strict();
export const UnpublishSchema = z
  .object({ ...context, studentIds: z.array(id).min(1).max(300).optional(), reason })
  .strict();

export const CellsSchema = z
  .object({
    ...context,
    cells: z
      .array(
        z
          .object({
            studentId: id,
            kind: z.enum(['SEMINAR', 'MIDTERM', 'FINAL']),
            answerId: id.optional(),
            score: z.number().finite().nullable(),
            reason: optionalReason,
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();

export const BulkSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('SEMINAR'),
      ...context,
      studentIds: z.array(id).min(1).max(300),
      score: seminarScore,
      comment,
      confirm: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('ATTENDANCE'),
      ...context,
      studentIds: z.array(id).min(1).max(300),
      classDate: z.string().datetime(),
      status: z.nativeEnum(AttendanceStatus),
      confirm: z.boolean().optional(),
    })
    .strict(),
]);
export type BulkDto = z.infer<typeof BulkSchema>;

export const ImportSchema = z
  .object({
    ...context,
    reason: optionalReason,
    rows: z
      .array(
        z
          .object({
            studentLoginId: z.string().trim().min(3).max(20),
            subjectCode: z.string().trim().max(20).optional(),
            academicYear: z.string().trim().max(9).optional(),
            term: z.string().trim().max(6).optional(),
            midterm: z.number().finite().optional(),
            final: z.number().finite().optional(),
            seminar: z.array(z.number().finite()).max(30).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export type ImportDto = z.infer<typeof ImportSchema>;

export const PeriodPatchSchema = z.object({ status: z.enum(['OPEN', 'CLOSED']), reason }).strict();

export const ExportQuerySchema = RecordsQuerySchema.omit({ page: true, pageSize: true }).extend({
  kind: z.enum(['records', 'answers']).default('records'),
});
