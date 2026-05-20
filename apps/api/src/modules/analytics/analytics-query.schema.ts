import { z } from 'zod';

export const analyticsFilterQuerySchema = z
  .object({
    from: z.string().trim().optional(),
    to: z.string().trim().optional(),
  })
  .refine(
    (o) =>
      (!o.from || !Number.isNaN(Date.parse(o.from))) &&
      (!o.to || !Number.isNaN(Date.parse(o.to))),
    { message: 'from and to must be valid dates when provided' },
  );

export type AnalyticsFilterQuery = z.infer<typeof analyticsFilterQuerySchema>;

export const qaCallsListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  hasOutcome: z.enum(['true', 'false']).optional(),
});

export type QaCallsListQuery = z.infer<typeof qaCallsListQuerySchema>;
