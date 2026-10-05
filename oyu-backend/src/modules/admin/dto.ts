import { z } from 'zod';

/** Типы помещений. Расширяемый список: новые типы можно использовать сразу, они хранятся строкой */
export const ROOM_TYPES = ['classroom', 'lecture_hall', 'lab', 'computer_lab', 'seminar_room', 'gym', 'other'] as const;
const roomType = z.string().trim().min(1).max(30).regex(/^[a-z0-9_]+$/);
const features = z.array(z.string().trim().min(1).max(30).regex(/^[a-z0-9_]+$/)).max(20);

export const CreateRoomSchema = z
  .object({
    code: z.string().min(1).max(20),
    name: z.string().max(100).optional(),
    building: z.string().max(100).optional(),
    floor: z.number().int().min(-3).max(60).nullable().optional(),
    capacity: z.number().int().positive().max(2000).default(30),
    type: roomType.default('classroom'),
    features: features.default([]),
    isActive: z.boolean().default(true),
    note: z.string().max(300).nullable().optional(),
  })
  .strict();

export const UpdateRoomSchema = z
  .object({
    name: z.string().max(100).optional(),
    building: z.string().max(100).nullable().optional(),
    floor: z.number().int().min(-3).max(60).nullable().optional(),
    capacity: z.number().int().positive().max(2000).optional(),
    type: roomType.optional(),
    features: features.optional(),
    isActive: z.boolean().optional(),
    note: z.string().max(300).nullable().optional(),
  })
  .strict();

export type CreateRoomDto = z.infer<typeof CreateRoomSchema>;
export type UpdateRoomDto = z.infer<typeof UpdateRoomSchema>;
