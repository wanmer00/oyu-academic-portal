import { z } from 'zod';

export const CreateAssignmentSchema = z
  .object({
    subjectCode: z.string().min(2).max(20),
    title: z.string().min(3).max(200),
    description: z.string().min(1).max(5000),
    dueDate: z.string().datetime(),
    maxGrade: z.number().min(1).max(100).default(100),
    publish: z.boolean().default(true), // false → черновик, студентам не виден
  })
  .strict();

export const UpdateAssignmentSchema = z
  .object({
    title: z.string().min(3).max(200).optional(),
    description: z.string().min(1).max(5000).optional(),
    dueDate: z.string().datetime().optional(),
    maxGrade: z.number().min(1).max(100).optional(),
  })
  .strict();

export const AssignmentStatusSchema = z
  .object({ status: z.enum(['DRAFT', 'PUBLISHED', 'CLOSED']) })
  .strict();

export const SubmitSchema = z
  .object({
    fileName: z.string().max(200).optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();

export const GradeSubmissionSchema = z
  .object({
    grade: z.number().min(0).max(100),
    feedback: z.string().max(2000).optional(),
  })
  .strict();

export type CreateAssignmentDto  = z.infer<typeof CreateAssignmentSchema>;
export type UpdateAssignmentDto  = z.infer<typeof UpdateAssignmentSchema>;
export type AssignmentStatusDto  = z.infer<typeof AssignmentStatusSchema>;
export type SubmitDto            = z.infer<typeof SubmitSchema>;
export type GradeSubmissionDto   = z.infer<typeof GradeSubmissionSchema>;
