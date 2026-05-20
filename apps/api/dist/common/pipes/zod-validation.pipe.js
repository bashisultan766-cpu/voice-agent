"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ZodValidationPipe = void 0;
const common_1 = require("@nestjs/common");
class ZodValidationPipe {
    constructor(schema) {
        this.schema = schema;
    }
    transform(value) {
        const r = this.schema.safeParse(value);
        if (!r.success) {
            const msg = r.error.issues[0]?.message ?? 'Invalid input';
            throw new common_1.BadRequestException({
                message: msg,
                code: 'VALIDATION_ERROR',
                issues: r.error.flatten(),
            });
        }
        return r.data;
    }
}
exports.ZodValidationPipe = ZodValidationPipe;
//# sourceMappingURL=zod-validation.pipe.js.map