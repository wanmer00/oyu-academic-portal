import { z } from 'zod';
import { AnnouncementAudience } from '@prisma/client';

export const CreateAnnouncementSchema = z
  .object({
    title: z.string().min(2).max(200),
    body: z.string().min(2).max(5000),
    audience: z.nativeEnum(AnnouncementAudience).default(AnnouncementAudience.ALL),
    groupName: z.string().max(50).optional(),
    priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
    pinned: z.boolean().default(false),
  })
  .strict();

export const UpdateAnnouncementSchema = CreateAnnouncementSchema.partial().strict();

export type CreateAnnouncementDto = z.infer<typeof CreateAnnouncementSchema>;
export type UpdateAnnouncementDto = z.infer<typeof UpdateAnnouncementSchema>;
