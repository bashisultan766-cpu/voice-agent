import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { KnowledgeDocType, KnowledgeStatus } from '@prisma/client';

@Injectable()
export class KnowledgeService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, dto: Record<string, unknown>) {
    return this.prisma.knowledgeDocument.create({
      data: {
        tenantId,
        storeId: dto.storeId as string,
        branchProfileId: dto.branchProfileId as string | undefined,
        title: dto.title as string,
        type: dto.type as KnowledgeDocType,
        status: (dto.status as KnowledgeStatus) ?? KnowledgeStatus.DRAFT,
        language: (dto.language as string) ?? 'en',
        content: dto.content as string,
        summary: dto.summary as string | undefined,
        isVoiceOptimized: (dto.isVoiceOptimized as boolean) ?? false,
      },
    });
  }

  async findAll(tenantId: string, storeId?: string, type?: KnowledgeDocType, status?: KnowledgeStatus) {
    return this.prisma.knowledgeDocument.findMany({
      where: {
        tenantId,
        ...(storeId && { storeId }),
        ...(type && { type }),
        ...(status && { status }),
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async findOne(tenantId: string, id: string) {
    const doc = await this.prisma.knowledgeDocument.findFirst({
      where: { id, tenantId },
    });
    if (!doc) throw new NotFoundException('Knowledge document not found');
    return doc;
  }

  async update(tenantId: string, id: string, dto: Record<string, unknown>) {
    await this.findOne(tenantId, id);
    return this.prisma.knowledgeDocument.update({
      where: { id },
      data: dto as never,
    });
  }

  async remove(tenantId: string, id: string) {
    await this.findOne(tenantId, id);
    return this.prisma.knowledgeDocument.delete({ where: { id } });
  }

  /** Retrieve active documents by type (e.g. SHIPPING_POLICY, RETURN_POLICY) for store/branch. */
  async getByType(tenantId: string, storeId: string, type: KnowledgeDocType, branchProfileId?: string) {
    return this.prisma.knowledgeDocument.findMany({
      where: {
        tenantId,
        storeId,
        type,
        status: KnowledgeStatus.ACTIVE,
        ...(branchProfileId && { branchProfileId }),
      },
      orderBy: { updatedAt: 'desc' },
      take: 3,
    });
  }
}
