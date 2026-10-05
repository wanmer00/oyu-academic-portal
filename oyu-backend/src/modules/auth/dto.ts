import { z } from 'zod';

export const LoginSchema = z
  .object({
    loginId: z.string().min(3).max(20),
    password: z.string().min(1).max(200),
  })
  .strict();

export type LoginDto = z.infer<typeof LoginSchema>;
