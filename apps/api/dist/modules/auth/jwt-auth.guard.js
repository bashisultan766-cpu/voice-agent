"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.JwtAuthGuard = void 0;
const common_1 = require("@nestjs/common");
const core_1 = require("@nestjs/core");
const jwt_1 = require("@nestjs/jwt");
const prisma_service_1 = require("../../database/prisma.service");
const constants_1 = require("../../common/constants");
let JwtAuthGuard = class JwtAuthGuard {
    constructor(reflector, jwt, prisma) {
        this.reflector = reflector;
        this.jwt = jwt;
        this.prisma = prisma;
    }
    async canActivate(context) {
        const isPublic = this.reflector.getAllAndOverride(constants_1.IS_PUBLIC_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        if (isPublic)
            return true;
        const req = context.switchToHttp().getRequest();
        const authHeader = req.headers?.authorization;
        const auth = Array.isArray(authHeader) ? authHeader[0] : authHeader;
        const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null;
        const devTenantHeaderFallback = process.env.NODE_ENV !== 'production' &&
            process.env.ALLOW_HEADER_TENANT_FALLBACK === 'true';
        if (!token && devTenantHeaderFallback) {
            const raw = req.headers['x-tenant-id'];
            const tid = Array.isArray(raw) ? raw[0] : raw;
            if (tid && typeof tid === 'string' && tid.trim()) {
                req.tenantId = tid.trim();
                return true;
            }
        }
        if (!token) {
            throw new common_1.UnauthorizedException('Authentication required. Sign in and send Authorization: Bearer <access_token> on API requests.');
        }
        let payload;
        try {
            payload = this.jwt.verify(token);
        }
        catch {
            throw new common_1.UnauthorizedException('Invalid or expired access token. Sign in again to obtain a new token.');
        }
        const user = await this.prisma.user.findFirst({
            where: { id: payload.sub, deletedAt: null },
            include: { tenant: true },
        });
        if (!user || user.tenant.deletedAt) {
            throw new common_1.UnauthorizedException('Account not found or tenant disabled. Sign in again or contact an administrator.');
        }
        req.tenantId = user.tenantId;
        req.userId = user.id;
        req.userEmail = user.email;
        req.userRole = user.role;
        return true;
    }
};
exports.JwtAuthGuard = JwtAuthGuard;
exports.JwtAuthGuard = JwtAuthGuard = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [core_1.Reflector,
        jwt_1.JwtService,
        prisma_service_1.PrismaService])
], JwtAuthGuard);
//# sourceMappingURL=jwt-auth.guard.js.map