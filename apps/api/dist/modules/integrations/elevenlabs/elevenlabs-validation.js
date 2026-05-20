"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.elevenLabsTestBodySchema = void 0;
const zod_1 = require("zod");
exports.elevenLabsTestBodySchema = zod_1.z.object({
    text: zod_1.z.string().trim().min(1).max(500).optional(),
    voiceId: zod_1.z.string().trim().min(1).max(128).optional(),
});
//# sourceMappingURL=elevenlabs-validation.js.map