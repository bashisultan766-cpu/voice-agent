"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TenantId = void 0;
const common_1 = require("@nestjs/common");
exports.TenantId = (0, common_1.createParamDecorator)((_data, ctx) => {
    const req = ctx.switchToHttp().getRequest();
    if (req.tenantId)
        return req.tenantId;
    if (process.env.NODE_ENV === 'production') {
        throw new common_1.UnauthorizedException('Missing tenant context');
    }
    const devTenantHeaderFallback = process.env.ALLOW_HEADER_TENANT_FALLBACK === 'true';
    if (devTenantHeaderFallback) {
        const raw = req.headers['x-tenant-id'];
        const v = Array.isArray(raw) ? raw[0] : raw;
        if (v && typeof v === 'string' && v.trim())
            return v.trim();
    }
    throw new common_1.UnauthorizedException('Missing tenant context');
});
//# sourceMappingURL=tenant-id.decorator.js.map