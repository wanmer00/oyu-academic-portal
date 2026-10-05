import { z } from 'zod';

// Только http(s): иначе url вида javascript: превращается в XSS-ссылку в интерфейсе
const httpUrl = z
  .string()
  .url()
  .max(2000)
  .refine((u) => /^https?:\/\//i.test(u), { message: 'Only http(s) URLs are allowed' });

export const CreateMaterialSchema = z
  .object({
    subjectCode: z.string().min(2).max(20),
    title: z.string().min(1).max(200),
    type: z.enum(['LINK', 'PDF', 'DOC', 'VIDEO', 'OTHER']).default('LINK'),
    url: httpUrl.optional(),
    fileName: z.string().max(200).optional(),
    assignmentId: z.string().min(1).max(40).optional(),
  })
  .strict()
  .refine((d) => !!d.url || !!d.fileName, { message: 'url or fileName required' });

export const UpdateMaterialSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    type: z.enum(['LINK', 'PDF', 'DOC', 'VIDEO', 'OTHER']).optional(),
    url: httpUrl.nullable().optional(),
    fileName: z.string().max(200).nullable().optional(),
    assignmentId: z.string().min(1).max(40).nullable().optional(),
  })
  .strict();

export type CreateMaterialDto = z.infer<typeof CreateMaterialSchema>;
export type UpdateMaterialDto = z.infer<typeof UpdateMaterialSchema>;
