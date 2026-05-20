"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.patchStoreBodySchema = exports.createStoreBodySchema = void 0;
const zod_1 = require("zod");
exports.createStoreBodySchema = zod_1.z.object({
    name: zod_1.z.string().trim().min(1).max(200),
    slug: zod_1.z
        .string()
        .trim()
        .min(1)
        .max(120)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase letters, numbers, and hyphens'),
});
exports.patchStoreBodySchema = zod_1.z
    .record(zod_1.z.string(), zod_1.z.unknown())
    .refine((o) => Object.keys(o).length > 0, { message: 'Body must not be empty' });
//# sourceMappingURL=stores-validation.js.map