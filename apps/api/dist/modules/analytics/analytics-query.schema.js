"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.qaCallsListQuerySchema = exports.analyticsFilterQuerySchema = void 0;
const zod_1 = require("zod");
exports.analyticsFilterQuerySchema = zod_1.z
    .object({
    from: zod_1.z.string().trim().optional(),
    to: zod_1.z.string().trim().optional(),
})
    .refine((o) => (!o.from || !Number.isNaN(Date.parse(o.from))) &&
    (!o.to || !Number.isNaN(Date.parse(o.to))), { message: 'from and to must be valid dates when provided' });
exports.qaCallsListQuerySchema = zod_1.z.object({
    limit: zod_1.z.coerce.number().int().min(1).max(200).optional(),
    hasOutcome: zod_1.z.enum(['true', 'false']).optional(),
});
//# sourceMappingURL=analytics-query.schema.js.map