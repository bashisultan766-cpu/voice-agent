"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TenantGuard = exports.TENANT_HEADER = void 0;
const common_1 = require("@nestjs/common");
exports.TENANT_HEADER = 'x-tenant-id';
let TenantGuard = class TenantGuard {
    canActivate(context) {
        const req = context.switchToHttp().getRequest();
        const tenantId = req.headers[exports.TENANT_HEADER];
        if (!tenantId || typeof tenantId !== 'string') {
            throw new common_1.BadRequestException(`Missing or invalid ${exports.TENANT_HEADER} header`);
        }
        req.tenantId = tenantId.trim();
        return true;
    }
};
exports.TenantGuard = TenantGuard;
exports.TenantGuard = TenantGuard = __decorate([
    (0, common_1.Injectable)()
], TenantGuard);
//# sourceMappingURL=tenant.guard.js.map