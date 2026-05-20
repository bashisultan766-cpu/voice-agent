import { z } from 'zod';

export const greetingQuerySchema = z.object({
  callSessionId: z.string().trim().min(1).max(40),
});

export const turnBodySchema = z.object({
  callSessionId: z.string().trim().min(1).max(40),
  message: z.string().trim().min(1).max(4000),
  history: z
    .array(
      z.object({
        role: z.union([z.literal('user'), z.literal('assistant')]),
        content: z.string().trim().min(1).max(4000),
      }),
    )
    .max(30)
    .optional(),
});
