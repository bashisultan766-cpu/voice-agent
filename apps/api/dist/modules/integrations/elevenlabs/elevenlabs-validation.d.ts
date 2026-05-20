import { z } from 'zod';
export declare const elevenLabsTestBodySchema: z.ZodObject<{
    text: z.ZodOptional<z.ZodString>;
    voiceId: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    text?: string | undefined;
    voiceId?: string | undefined;
}, {
    text?: string | undefined;
    voiceId?: string | undefined;
}>;
