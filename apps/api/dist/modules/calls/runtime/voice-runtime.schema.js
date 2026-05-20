"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.turnBodySchema = exports.greetingQuerySchema = void 0;
const zod_1 = require("zod");
exports.greetingQuerySchema = zod_1.z.object({
    callSessionId: zod_1.z.string().trim().min(1).max(40),
});
exports.turnBodySchema = zod_1.z.object({
    callSessionId: zod_1.z.string().trim().min(1).max(40),
    message: zod_1.z.string().trim().min(1).max(4000),
    history: zod_1.z
        .array(zod_1.z.object({
        role: zod_1.z.union([zod_1.z.literal('user'), zod_1.z.literal('assistant')]),
        content: zod_1.z.string().trim().min(1).max(4000),
    }))
        .max(30)
        .optional(),
});
//# sourceMappingURL=voice-runtime.schema.js.map