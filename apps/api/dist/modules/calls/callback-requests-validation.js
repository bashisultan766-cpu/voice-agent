"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.callbackPatchStatusBodySchema = exports.callbackListQuerySchema = void 0;
const zod_1 = require("zod");
const client_1 = require("@prisma/client");
exports.callbackListQuerySchema = zod_1.z.object({
    status: zod_1.z.nativeEnum(client_1.CallbackRequestStatus).optional(),
    limit: zod_1.z.coerce.number().int().min(1).max(200).optional(),
});
exports.callbackPatchStatusBodySchema = zod_1.z.object({
    status: zod_1.z.nativeEnum(client_1.CallbackRequestStatus).optional(),
});
//# sourceMappingURL=callback-requests-validation.js.map