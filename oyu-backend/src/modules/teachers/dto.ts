import { z } from 'zod';
import { RequestStatus } from '@prisma/client';

export const AnalyticsQuerySchema = z.object({
  groupName: z.string().min(1).max(50).optional(),
  subjectCode: z.string().min(2).max(20).optional(),
});

export const ReplyRequestSchema = z
  .object({
    // общий ответ на заявку; статусы апелляций по экзамену (UNDER_REVIEW / PARTIALLY_APPROVED / WITHDRAWN) задаёт только workflow апелляции
    status: z.enum([RequestStatus.PENDING, RequestStatus.APPROVED, RequestStatus.REJECTED]),
    adminNote: z.string().max(1000).optional(),
  })
  .strict();

export type ReplyRequestDto = z.infer<typeof ReplyRequestSchema>;
