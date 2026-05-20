import { z } from 'zod';
export declare const analyticsFilterQuerySchema: z.ZodEffects<z.ZodObject<{
    from: z.ZodOptional<z.ZodString>;
    to: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    from?: string | undefined;
    to?: string | undefined;
}, {
    from?: string | undefined;
    to?: string | undefined;
}>, {
    from?: string | undefined;
    to?: string | undefined;
}, {
    from?: string | undefined;
    to?: string | undefined;
}>;
export type AnalyticsFilterQuery = z.infer<typeof analyticsFilterQuerySchema>;
export declare const qaCallsListQuerySchema: z.ZodObject<{
    limit: z.ZodOptional<z.ZodNumber>;
    hasOutcome: z.ZodOptional<z.ZodEnum<["true", "false"]>>;
}, "strip", z.ZodTypeAny, {
    limit?: number | undefined;
    hasOutcome?: "true" | "false" | undefined;
}, {
    limit?: number | undefined;
    hasOutcome?: "true" | "false" | undefined;
}>;
export type QaCallsListQuery = z.infer<typeof qaCallsListQuerySchema>;
