import { z } from 'zod';
import { CalendarEventType, StudyLevel } from '@prisma/client';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const Base = z
  .object({
    eventDate: z.string().datetime(),
    endDate: z.string().datetime().nullable().optional(),
    type: z.nativeEnum(CalendarEventType),
    title: z.string().trim().min(1).max(200),
    description: z.string().max(2000).nullable().optional(),
    groupName: z.string().trim().max(50).nullable().optional(),
    level: z.nativeEnum(StudyLevel).nullable().optional(),
    startTime: z.string().regex(TIME_RE).nullable().optional(),
    endTime: z.string().regex(TIME_RE).nullable().optional(),
    roomCode: z.string().trim().max(20).nullable().optional(),
    // Конфликт с регулярным занятием в этой аудитории можно осознанно разрешить (например, экзамен вместо лекции).
    // Конфликт с другим событием в той же аудитории — нельзя.
    allowScheduleOverlap: z.boolean().optional(),
  })
  .strict();

const checkTimes = (d: { startTime?: string | null; endTime?: string | null; eventDate?: string; endDate?: string | null }, ctx: z.RefinementCtx) => {
  if ((d.startTime && !d.endTime) || (!d.startTime && d.endTime)) ctx.addIssue({ code: 'custom', message: 'startTime and endTime go together', path: ['endTime'] });
  if (d.startTime && d.endTime && d.startTime >= d.endTime) ctx.addIssue({ code: 'custom', message: 'startTime must be before endTime', path: ['endTime'] });
  if (d.eventDate && d.endDate && new Date(d.endDate) < new Date(d.eventDate)) ctx.addIssue({ code: 'custom', message: 'endDate must not be before eventDate', path: ['endDate'] });
};

export const CreateEventSchema = Base.superRefine(checkTimes);
export const UpdateEventSchema = Base.partial().strict().superRefine(checkTimes);
export const CheckEventSchema = Base.extend({ excludeId: z.string().max(40).optional() }).strict();

export type CreateEventDto = z.infer<typeof CreateEventSchema>;
export type UpdateEventDto = z.infer<typeof UpdateEventSchema>;
export type CheckEventDto = z.infer<typeof CheckEventSchema>;
