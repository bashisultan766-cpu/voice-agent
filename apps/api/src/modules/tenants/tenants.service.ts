import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class TenantsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: { name: string; slug: string }) {
    return this.prisma.tenant.create({ data });
  }

  async findOne(id: string) {
    return this.prisma.tenant.findUniqueOrThrow({ where: { id } });
  }
}
