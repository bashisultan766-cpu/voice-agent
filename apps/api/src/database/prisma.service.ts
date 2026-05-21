import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Nest injectable Prisma client. Extends generated `PrismaClient` so delegates
 * like `callSession`, `agent`, and `tenantIntegration` match `schema.prisma`.
 * Regenerate after schema edits: `pnpm --filter api exec prisma generate`
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
