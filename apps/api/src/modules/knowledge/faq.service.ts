import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class FaqService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, dto: { storeId: string; branchProfileId?: string; question: string; answer: string; language?: string; tags?: string; priority?: number; isActive?: boolean }) {
    return this.prisma.storeFAQ.create({
      data: {
        tenantId,
        storeId: dto.storeId,
        branchProfileId: dto.branchProfileId,
        question: dto.question,
        answer: dto.answer,
        language: dto.language ?? 'en',
        tags: dto.tags,
        priority: dto.priority ?? 0,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async findAll(tenantId: string, storeId?: string, branchProfileId?: string, isActive?: boolean) {
    return this.prisma.storeFAQ.findMany({
      where: {
        tenantId,
        ...(storeId && { storeId }),
        ...(branchProfileId && { branchProfileId }),
        ...(isActive !== undefined && { isActive }),
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async findOne(tenantId: string, id: string) {
    const faq = await this.prisma.storeFAQ.findFirst({
      where: { id, tenantId },
    });
    if (!faq) throw new NotFoundException('FAQ not found');
    return faq;
  }

  async update(tenantId: string, id: string, dto: Partial<{ question: string; answer: string; language: string; tags: string; priority: number; isActive: boolean }>) {
    await this.findOne(tenantId, id);
    return this.prisma.storeFAQ.update({
      where: { id },
      data: dto,
    });
  }

  async remove(tenantId: string, id: string) {
    await this.findOne(tenantId, id);
    return this.prisma.storeFAQ.delete({ where: { id } });
  }

  /** Search FAQs by store (and optional branch/city) for voice retrieval. */
  async search(tenantId: string, storeId: string, query: string, branchProfileId?: string, limit = 5) {
    const q = query.toLowerCase().trim();
    const faqs = await this.prisma.storeFAQ.findMany({
      where: {
        tenantId,
        storeId,
        isActive: true,
        ...(branchProfileId && { branchProfileId }),
        OR: [
          { question: { contains: q, mode: 'insensitive' } },
          { answer: { contains: q, mode: 'insensitive' } },
          { tags: { contains: q, mode: 'insensitive' } },
        ],
      },
      take: limit,
      orderBy: { priority: 'desc' },
    });
    return faqs.map((f) => ({ id: f.id, question: f.question, answer: f.answer, branchProfileId: f.branchProfileId }));
  }
}
