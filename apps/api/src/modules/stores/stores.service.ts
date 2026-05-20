import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class StoresService {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: { tenantId: string; name: string; slug: string }) {
    return this.prisma.store.create({ data });
  }

  async findAll(tenantId: string) {
    return this.prisma.store.findMany({ where: { tenantId, deletedAt: null } });
  }

  async updateForTenant(tenantId: string, id: string, data: Record<string, unknown>) {
    const store = await this.prisma.store.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!store) throw new NotFoundException('Store not found');
    const updated = await this.prisma.store.updateMany({
      where: { id, tenantId, deletedAt: null },
      data: data as never,
    });
    if (updated.count === 0) throw new NotFoundException('Store not found');
    return this.prisma.store.findFirstOrThrow({ where: { id, tenantId, deletedAt: null } });
  }
}
