import { z } from 'zod';
export declare const callbackListQuerySchema: z.ZodObject<{
    status: z.ZodOptional<z.ZodNativeEnum<{
        OPEN: "OPEN";
        IN_PROGRESS: "IN_PROGRESS";
        COMPLETED: "COMPLETED";
        CANCELLED: "CANCELLED";
    }>>;
    limit: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    status?: "IN_PROGRESS" | "COMPLETED" | "OPEN" | "CANCELLED" | undefined;
    limit?: number | undefined;
}, {
    status?: "IN_PROGRESS" | "COMPLETED" | "OPEN" | "CANCELLED" | undefined;
    limit?: number | undefined;
}>;
export declare const callbackPatchStatusBodySchema: z.ZodObject<{
    status: z.ZodOptional<z.ZodNativeEnum<{
        OPEN: "OPEN";
        IN_PROGRESS: "IN_PROGRESS";
        COMPLETED: "COMPLETED";
        CANCELLED: "CANCELLED";
    }>>;
}, "strip", z.ZodTypeAny, {
    status?: "IN_PROGRESS" | "COMPLETED" | "OPEN" | "CANCELLED" | undefined;
}, {
    status?: "IN_PROGRESS" | "COMPLETED" | "OPEN" | "CANCELLED" | undefined;
}>;
