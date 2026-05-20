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
exports.BranchProfileService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../database/prisma.service");
let BranchProfileService = class BranchProfileService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async create(tenantId, dto) {
        return this.prisma.branchProfile.create({
            data: {
                tenantId,
                storeId: dto.storeId,
                branchCode: dto.branchCode,
                name: dto.name,
                city: dto.city,
                area: dto.area,
                address: dto.address,
                phone: dto.phone,
                whatsapp: dto.whatsapp,
                email: dto.email,
                openingHoursJson: dto.openingHoursJson ?? undefined,
                pickupAvailable: dto.pickupAvailable ?? false,
                deliveryAvailable: dto.deliveryAvailable ?? false,
                notes: dto.notes,
                isActive: dto.isActive ?? true,
            },
        });
    }
    async findAll(tenantId, storeId, city, isActive) {
        return this.prisma.branchProfile.findMany({
            where: {
                tenantId,
                ...(storeId && { storeId }),
                ...(city && { city }),
                ...(isActive !== undefined && { isActive }),
            },
            orderBy: { name: 'asc' },
        });
    }
    async findOne(tenantId, id) {
        const branch = await this.prisma.branchProfile.findFirst({
            where: { id, tenantId },
        });
        if (!branch)
            throw new common_1.NotFoundException('Branch not found');
        return branch;
    }
    async update(tenantId, id, dto) {
        await this.findOne(tenantId, id);
        return this.prisma.branchProfile.update({
            where: { id },
            data: dto,
        });
    }
    async remove(tenantId, id) {
        await this.findOne(tenantId, id);
        return this.prisma.branchProfile.delete({ where: { id } });
    }
    async getByStore(tenantId, storeId, branchId, city) {
        if (branchId) {
            const one = await this.prisma.branchProfile.findFirst({
                where: { id: branchId, tenantId, storeId, isActive: true },
            });
            return one ? [one] : [];
        }
        return this.prisma.branchProfile.findMany({
            where: {
                tenantId,
                storeId,
                isActive: true,
                ...(city && { city }),
            },
            orderBy: { name: 'asc' },
        });
    }
};
exports.BranchProfileService = BranchProfileService;
exports.BranchProfileService = BranchProfileService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], BranchProfileService);
//# sourceMappingURL=branch-profile.service.js.map