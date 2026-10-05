import { AttendanceStatus, Term } from '@prisma/client';
import { z } from 'zod';

const group = z.string().min(1).max(50);
const subjectCode = z.string().min(2).max(20);
const anyDate = z.string().min(8).max(40).refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid date');

export const MarkSchema = z
  .object({
    groupName: group,
    subjectCode,
    classDate: z.string().datetime(),
    entries: z
      .array(z.object({ studentLoginId: z.string().min(3).max(20), status: z.nativeEnum(AttendanceStatus) }))
      .min(1)
      .max(200),
  })
  .strict();

export const ClearSchema = z
  .object({
    groupName: group,
    subjectCode,
    classDate: z.string().datetime(),
    studentLoginIds: z.array(z.string().min(3).max(20)).min(1).max(200),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export const DayQuerySchema = z.object({ groupName: group, subjectCode, classDate: anyDate });

export const StatsQuerySchema = z.object({
  groupName: group,
  subjectCode,
  from: anyDate.optional(),
  to: anyDate.optional(),
  studentLoginId: z.string().min(3).max(20).optional(),
});

export const ExportQuerySchema = z.object({
  groupName: group,
  subjectCode,
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export const StudentQuerySchema = z.object({
  studentId: z.string().min(1).max(40).optional(),
  academicYear: z.string().min(4).max(20).optional(),
  term: z.nativeEnum(Term).optional(),
});

export const ReportQuerySchema = z.object({
  from: anyDate.optional(),
  to: anyDate.optional(),
  groupName: group.optional(),
});

export type MarkDto = z.infer<typeof MarkSchema>;
export type ClearDto = z.infer<typeof ClearSchema>;
export type DayQuery = z.infer<typeof DayQuerySchema>;
export type StatsQuery = z.infer<typeof StatsQuerySchema>;
export type ExportQuery = z.infer<typeof ExportQuerySchema>;
export type StudentQuery = z.infer<typeof StudentQuerySchema>;
export type ReportQuery = z.infer<typeof ReportQuerySchema>;
