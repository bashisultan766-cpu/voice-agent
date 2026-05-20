import { z } from 'zod';
import { CallbackRequestStatus } from '@prisma/client';

export const callbackListQuerySchema = z.object({
  status: z.nativeEnum(CallbackRequestStatus).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const callbackPatchStatusBodySchema = z.object({
  status: z.nativeEnum(CallbackRequestStatus).optional(),
});
