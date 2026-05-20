import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { KnowledgeController } from './knowledge.controller';
import { FaqService } from './faq.service';
import { BranchProfileService } from './branch-profile.service';
import { KnowledgeService } from './knowledge.service';
import { RetrievalService } from './retrieval.service';
import { VectorStoreService } from './vector-store.service';
import { KnowledgeIngestionService } from './knowledge-ingestion.service';
import { RetrievalOrchestratorService } from './retrieval-orchestrator.service';

@Module({
  imports: [ConfigModule],
  controllers: [KnowledgeController],
  providers: [
    FaqService,
    BranchProfileService,
    KnowledgeService,
    RetrievalService,
    VectorStoreService,
    KnowledgeIngestionService,
    RetrievalOrchestratorService,
  ],
  exports: [
    FaqService,
    BranchProfileService,
    KnowledgeService,
    RetrievalService,
    VectorStoreService,
    KnowledgeIngestionService,
    RetrievalOrchestratorService,
  ],
})
export class KnowledgeModule {}
