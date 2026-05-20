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
exports.AuthService = void 0;
const common_1 = require("@nestjs/common");
const jwt_1 = require("@nestjs/jwt");
const bcrypt = require("bcrypt");
const prisma_service_1 = require("../../database/prisma.service");
function slugify(s) {
    const x = s
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, '')
        .replace(/[\s_-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return x || 'workspace';
}
let AuthService = class AuthService {
    constructor(prisma, jwt) {
        this.prisma = prisma;
        this.jwt = jwt;
    }
    async register(dto) {
        const email = dto.email.trim().toLowerCase();
        const existingEmail = await this.prisma.user.findFirst({
            where: { email, deletedAt: null },
            select: { id: true },
        });
        if (existingEmail) {
            throw new common_1.ConflictException('This email is already registered. Sign in with your workspace slug, or use a different email.');
        }
        let slug;
        if (dto.workspaceSlug?.trim()) {
            slug = dto.workspaceSlug.trim().toLowerCase();
            const taken = await this.prisma.tenant.findFirst({
                where: { slug, deletedAt: null },
                select: { id: true },
            });
            if (taken) {
                throw new common_1.ConflictException('This workspace slug is already taken. Choose another.');
            }
        }
        else {
            const baseSlug = slugify(dto.workspaceName);
            slug = baseSlug;
            let n = 0;
            while (await this.prisma.tenant.findFirst({ where: { slug, deletedAt: null } })) {
                slug = `${baseSlug}-${++n}`;
            }
        }
        const passwordHash = await bcrypt.hash(dto.password, 12);
        const tenant = await this.prisma.tenant.create({
            data: { name: dto.workspaceName.trim(), slug },
        });
        try {
            const user = await this.prisma.user.create({
                data: {
                    tenantId: tenant.id,
                    email,
                    fullName: dto.fullName.trim(),
                    passwordHash,
                    role: 'OWNER',
                },
            });
            await this.prisma.client.create({
                data: {
                    tenantId: tenant.id,
                    name: `${tenant.name} — default`,
                    contactEmail: email,
                },
            });
            const accessToken = this.jwt.sign({ sub: user.id });
            return {
                accessToken,
                tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
                user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role },
            };
        }
        catch (e) {
            await this.prisma.tenant.delete({ where: { id: tenant.id } }).catch(() => undefined);
            const code = e && typeof e === 'object' && 'code' in e ? String(e.code) : '';
            if (code === 'P2002') {
                throw new common_1.ConflictException('This email or workspace slug is already in use.');
            }
            throw new common_1.UnauthorizedException('Registration failed.');
        }
    }
    async login(dto) {
        const email = dto.email.trim().toLowerCase();
        const requestedSlug = dto.tenantSlug.trim().toLowerCase();
        let tenant = await this.prisma.tenant.findFirst({
            where: { slug: requestedSlug, deletedAt: null },
        });
        let user = tenant
            ? await this.prisma.user.findFirst({
                where: { tenantId: tenant.id, email, deletedAt: null },
            })
            : null;
        if (!user) {
            const candidates = await this.prisma.user.findMany({
                where: { email, deletedAt: null, tenant: { deletedAt: null } },
                include: { tenant: true },
                take: 2,
            });
            if (candidates.length === 1) {
                user = candidates[0];
                tenant = candidates[0].tenant;
            }
        }
        if (!tenant || !user)
            throw new common_1.UnauthorizedException('Unknown workspace or invalid credentials');
        if (!user?.passwordHash)
            throw new common_1.UnauthorizedException('Invalid credentials');
        const ok = await bcrypt.compare(dto.password, user.passwordHash);
        if (!ok)
            throw new common_1.UnauthorizedException('Invalid credentials');
        const accessToken = this.jwt.sign({ sub: user.id });
        return {
            accessToken,
            tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
            user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role },
        };
    }
    async me(userId) {
        const user = await this.prisma.user.findFirst({
            where: { id: userId, deletedAt: null },
            include: { tenant: true },
        });
        if (!user || user.tenant.deletedAt)
            throw new common_1.UnauthorizedException();
        return {
            tenant: { id: user.tenant.id, name: user.tenant.name, slug: user.tenant.slug },
            user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role },
        };
    }
};
exports.AuthService = AuthService;
exports.AuthService = AuthService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        jwt_1.JwtService])
], AuthService);
//# sourceMappingURL=auth.service.js.map