import { z } from 'zod';
import { RequestType } from '@prisma/client';
import { AppealInputSchema } from './appeals.service';

export const CreateRequestSchema = z
  .object({
    type: z.nativeEnum(RequestType),
    description: z.string().min(5).max(2000).optional(),
    // APPEAL по экзамену: результат + спорные вопросы (причина и объяснение для каждого)
    appeal: AppealInputSchema.optional(),
  })
  .strict()
  .refine((v) => !!v.appeal || !!v.description, { message: 'description is required', path: ['description'] })
  .refine((v) => !v.appeal || v.type === RequestType.APPEAL, { message: 'appeal details are allowed only for APPEAL', path: ['appeal'] });

export type CreateRequestDto = z.infer<typeof CreateRequestSchema>;

export const UpdateRequestSchema = z
  .object({
    type: z.nativeEnum(RequestType).optional(),
    description: z.string().min(5).max(2000).optional(),
  })
  .strict();

export type UpdateRequestDto = z.infer<typeof UpdateRequestSchema>;
