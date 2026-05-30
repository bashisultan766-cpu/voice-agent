import { z } from 'zod';
export declare const simulateToolBodySchema: z.ZodObject<{
    toolName: z.ZodString;
    args: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    callSessionId: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    toolName: string;
    callSessionId?: string | undefined;
    args?: Record<string, unknown> | undefined;
}, {
    toolName: string;
    callSessionId?: string | undefined;
    args?: Record<string, unknown> | undefined;
}>;
export declare const testEmailBodySchema: z.ZodObject<{
    toEmail: z.ZodString;
    checkoutUrl: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    toEmail: string;
    checkoutUrl?: string | undefined;
}, {
    toEmail: string;
    checkoutUrl?: string | undefined;
}>;
export declare const simulateBuyingFlowBodySchema: z.ZodObject<{
    query: z.ZodOptional<z.ZodString>;
    customerEmail: z.ZodOptional<z.ZodString>;
    sendEmail: z.ZodOptional<z.ZodBoolean>;
    checkoutMode: z.ZodOptional<z.ZodEnum<["STOREFRONT_CART", "DRAFT_ORDER_INVOICE"]>>;
    callSessionId: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    query?: string | undefined;
    callSessionId?: string | undefined;
    checkoutMode?: "STOREFRONT_CART" | "DRAFT_ORDER_INVOICE" | undefined;
    customerEmail?: string | undefined;
    sendEmail?: boolean | undefined;
}, {
    query?: string | undefined;
    callSessionId?: string | undefined;
    checkoutMode?: "STOREFRONT_CART" | "DRAFT_ORDER_INVOICE" | undefined;
    customerEmail?: string | undefined;
    sendEmail?: boolean | undefined;
}>;
export declare const fullReadinessSmokeBodySchema: z.ZodObject<{
    query: z.ZodOptional<z.ZodString>;
    customerEmail: z.ZodOptional<z.ZodString>;
    runFlowSimulation: z.ZodOptional<z.ZodBoolean>;
    sendEmail: z.ZodOptional<z.ZodBoolean>;
    checkoutMode: z.ZodOptional<z.ZodEnum<["STOREFRONT_CART", "DRAFT_ORDER_INVOICE"]>>;
    callSessionId: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    query?: string | undefined;
    callSessionId?: string | undefined;
    checkoutMode?: "STOREFRONT_CART" | "DRAFT_ORDER_INVOICE" | undefined;
    customerEmail?: string | undefined;
    sendEmail?: boolean | undefined;
    runFlowSimulation?: boolean | undefined;
}, {
    query?: string | undefined;
    callSessionId?: string | undefined;
    checkoutMode?: "STOREFRONT_CART" | "DRAFT_ORDER_INVOICE" | undefined;
    customerEmail?: string | undefined;
    sendEmail?: boolean | undefined;
    runFlowSimulation?: boolean | undefined;
}>;
export declare const cuidParamSchema: z.ZodString;
