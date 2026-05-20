import { Controller, Get, Post, Patch, Delete, Param, Body, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { FaqService } from './faq.service';
import { BranchProfileService } from './branch-profile.service';
import { KnowledgeService } from './knowledge.service';
import { RetrievalService } from './retrieval.service';
import { KnowledgeIngestionService } from './knowledge-ingestion.service';
import { RetrievalOrchestratorService } from './retrieval-orchestrator.service';
import { CreateFaqDto } from './dto/create-faq.dto';
import { UpdateFaqDto } from './dto/update-faq.dto';
import { CreateBranchProfileDto } from './dto/create-branch-profile.dto';
import { UpdateBranchProfileDto } from './dto/update-branch-profile.dto';
import { CreateKnowledgeDocumentDto } from './dto/create-knowledge-document.dto';
import { UpdateKnowledgeDocumentDto } from './dto/update-knowledge-document.dto';
import { SearchKnowledgeDto } from './dto/search-knowledge.dto';
import { KnowledgeDocType, KnowledgeStatus } from '@prisma/client';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

@Controller('knowledge')
@Roles(UserRole.MANAGER)
export class KnowledgeController {
  constructor(
    private readonly faqService: FaqService,
    private readonly branchProfileService: BranchProfileService,
    private readonly knowledgeService: KnowledgeService,
    private readonly retrievalService: RetrievalService,
    private readonly knowledgeIngestion: KnowledgeIngestionService,
    private readonly retrievalOrchestrator: RetrievalOrchestratorService,
  ) {}

  // ——— FAQs ———
  @Post('faqs')
  createFaq(@TenantId() tenantId: string, @Body() dto: CreateFaqDto) {
    return this.faqService.create(tenantId, dto);
  }

  @Get('faqs')
  listFaqs(
    @TenantId() tenantId: string,
    @Query('storeId') storeId?: string,
    @Query('branchProfileId') branchProfileId?: string,
    @Query('isActive') isActive?: string,
  ) {
    return this.faqService.findAll(
      tenantId,
      storeId,
      branchProfileId,
      isActive === 'true' ? true : isActive === 'false' ? false : undefined,
    );
  }

  @Get('faqs/:id')
  getFaq(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.faqService.findOne(tenantId, id);
  }

  @Patch('faqs/:id')
  updateFaq(@TenantId() tenantId: string, @Param('id') id: string, @Body() dto: UpdateFaqDto) {
    return this.faqService.update(tenantId, id, dto);
  }

  @Delete('faqs/:id')
  deleteFaq(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.faqService.remove(tenantId, id);
  }

  // ——— Branch profiles ———
  @Post('branches')
  createBranch(@TenantId() tenantId: string, @Body() dto: CreateBranchProfileDto) {
    return this.branchProfileService.create(tenantId, dto as unknown as Record<string, unknown>);
  }

  @Get('branches')
  listBranches(
    @TenantId() tenantId: string,
    @Query('storeId') storeId?: string,
    @Query('city') city?: string,
    @Query('isActive') isActive?: string,
  ) {
    return this.branchProfileService.findAll(
      tenantId,
      storeId,
      city,
      isActive === 'true' ? true : isActive === 'false' ? false : undefined,
    );
  }

  @Get('branches/:id')
  getBranch(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.branchProfileService.findOne(tenantId, id);
  }

  @Patch('branches/:id')
  updateBranch(@TenantId() tenantId: string, @Param('id') id: string, @Body() dto: UpdateBranchProfileDto) {
    return this.branchProfileService.update(tenantId, id, dto as unknown as Record<string, unknown>);
  }

  @Delete('branches/:id')
  deleteBranch(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.branchProfileService.remove(tenantId, id);
  }

  // ——— Knowledge documents ———
  @Post('documents')
  createDocument(@TenantId() tenantId: string, @Body() dto: CreateKnowledgeDocumentDto) {
    return this.knowledgeService.create(tenantId, dto as unknown as Record<string, unknown>);
  }

  @Get('documents')
  listDocuments(
    @TenantId() tenantId: string,
    @Query('storeId') storeId?: string,
    @Query('type') type?: KnowledgeDocType,
    @Query('status') status?: string,
  ) {
    return this.knowledgeService.findAll(tenantId, storeId, type, status as never);
  }

  @Get('documents/:id')
  getDocument(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.knowledgeService.findOne(tenantId, id);
  }

  @Patch('documents/:id')
  updateDocument(@TenantId() tenantId: string, @Param('id') id: string, @Body() dto: UpdateKnowledgeDocumentDto) {
    return this.knowledgeService.update(tenantId, id, dto as unknown as Record<string, unknown>);
  }

  @Delete('documents/:id')
  deleteDocument(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.knowledgeService.remove(tenantId, id);
  }

  @Post('documents/:id/reindex')
  async reindexDocument(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.knowledgeIngestion.syncDocumentToVectorStore(tenantId, id);
  }

  @Post('documents/:id/archive')
  archiveDocument(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.knowledgeService.update(tenantId, id, { status: KnowledgeStatus.ARCHIVED } as unknown as Record<string, unknown>);
  }

  // ——— Retrieval (test / voice) ———
  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @Post('search')
  async search(@TenantId() tenantId: string, @Body() dto: SearchKnowledgeDto) {
    if (!dto.storeId) {
      return { ok: true, source: 'faq' as const, items: [], voiceSummary: 'Provide storeId to search.' };
    }
    return this.retrievalOrchestrator.retrieve({
      tenantId,
      storeId: dto.storeId,
      query: dto.query,
      branchProfileId: dto.branchProfileId,
      city: dto.city,
      topK: dto.topK ?? 5,
    });
  }
}
