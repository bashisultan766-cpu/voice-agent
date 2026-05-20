"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cuidParamSchema = exports.fullReadinessSmokeBodySchema = exports.simulateBuyingFlowBodySchema = exports.testEmailBodySchema = exports.simulateToolBodySchema = void 0;
const zod_1 = require("zod");
exports.simulateToolBodySchema = zod_1.z.object({
    toolName: zod_1.z.string().trim().min(1).max(128),
    args: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).optional(),
    callSessionId: zod_1.z.string().trim().min(20).max(32).optional(),
});
exports.testEmailBodySchema = zod_1.z.object({
    toEmail: zod_1.z.string().email().max(320),
    checkoutUrl: zod_1.z.string().url().max(2048).optional(),
});
exports.simulateBuyingFlowBodySchema = zod_1.z.object({
    query: zod_1.z.string().trim().min(1).max(160).optional(),
    customerEmail: zod_1.z.string().email().max(320).optional(),
    sendEmail: zod_1.z.boolean().optional(),
    checkoutMode: zod_1.z.enum(['STOREFRONT_CART', 'DRAFT_ORDER_INVOICE']).optional(),
    callSessionId: zod_1.z.string().trim().min(20).max(32).optional(),
});
exports.fullReadinessSmokeBodySchema = zod_1.z.object({
    query: zod_1.z.string().trim().min(1).max(160).optional(),
    customerEmail: zod_1.z.string().email().max(320).optional(),
    runFlowSimulation: zod_1.z.boolean().optional(),
    sendEmail: zod_1.z.boolean().optional(),
    checkoutMode: zod_1.z.enum(['STOREFRONT_CART', 'DRAFT_ORDER_INVOICE']).optional(),
    callSessionId: zod_1.z.string().trim().min(20).max(32).optional(),
});
exports.cuidParamSchema = zod_1.z
    .string()
    .trim()
    .min(20)
    .max(32)
    .regex(/^c[a-z0-9]+$/i, 'Invalid id');
//# sourceMappingURL=ops-validation.js.map