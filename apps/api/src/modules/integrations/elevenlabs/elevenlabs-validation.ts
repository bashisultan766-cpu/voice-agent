import { z } from 'zod';

export const elevenLabsTestBodySchema = z.object({
  text: z.string().trim().min(1).max(500).optional(),
  voiceId: z.string().trim().min(1).max(128).optional(),
});
