import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class BranchProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, dto: Record<string, unknown>) {
    return this.prisma.branchProfile.create({
      data: {
        tenantId,
        storeId: dto.storeId as string,
        branchCode: dto.branchCode as string | undefined,
        name: dto.name as string,
        city: dto.city as string | undefined,
        area: dto.area as string | undefined,
        address: dto.address as string | undefined,
        phone: dto.phone as string | undefined,
        whatsapp: dto.whatsapp as string | undefined,
        email: dto.email as string | undefined,
        openingHoursJson: (dto.openingHoursJson as object) ?? undefined,
        pickupAvailable: (dto.pickupAvailable as boolean) ?? false,
        deliveryAvailable: (dto.deliveryAvailable as boolean) ?? false,
        notes: dto.notes as string | undefined,
        isActive: (dto.isActive as boolean) ?? true,
      },
    });
  }

  async findAll(tenantId: string, storeId?: string, city?: string, isActive?: boolean) {
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

  async findOne(tenantId: string, id: string) {
    const branch = await this.prisma.branchProfile.findFirst({
      where: { id, tenantId },
    });
    if (!branch) throw new NotFoundException('Branch not found');
    return branch;
  }

  async update(tenantId: string, id: string, dto: Record<string, unknown>) {
    await this.findOne(tenantId, id);
    return this.prisma.branchProfile.update({
      where: { id },
      data: dto as never,
    });
  }

  async remove(tenantId: string, id: string) {
    await this.findOne(tenantId, id);
    return this.prisma.branchProfile.delete({ where: { id } });
  }

  /** Get branch by store and optional city/name for voice tools. */
  async getByStore(tenantId: string, storeId: string, branchId?: string, city?: string) {
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
}
