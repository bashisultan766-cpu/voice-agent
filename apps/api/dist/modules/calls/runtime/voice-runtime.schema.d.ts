import { z } from 'zod';
export declare const greetingQuerySchema: z.ZodObject<{
    callSessionId: z.ZodString;
}, "strip", z.ZodTypeAny, {
    callSessionId: string;
}, {
    callSessionId: string;
}>;
export declare const turnBodySchema: z.ZodObject<{
    callSessionId: z.ZodString;
    message: z.ZodString;
    history: z.ZodOptional<z.ZodArray<z.ZodObject<{
        role: z.ZodUnion<[z.ZodLiteral<"user">, z.ZodLiteral<"assistant">]>;
        content: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        role: "user" | "assistant";
        content: string;
    }, {
        role: "user" | "assistant";
        content: string;
    }>, "many">>;
}, "strip", z.ZodTypeAny, {
    callSessionId: string;
    message: string;
    history?: {
        role: "user" | "assistant";
        content: string;
    }[] | undefined;
}, {
    callSessionId: string;
    message: string;
    history?: {
        role: "user" | "assistant";
        content: string;
    }[] | undefined;
}>;
