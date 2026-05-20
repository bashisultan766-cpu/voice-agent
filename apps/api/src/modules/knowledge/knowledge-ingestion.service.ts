import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { VectorStoreService } from './vector-store.service';
import { KnowledgeSyncJobStatus } from '@prisma/client';

@Injectable()
export class KnowledgeIngestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vectorStore: VectorStoreService,
  ) {}

  /**
   * Sync a knowledge document to the vector store (upload content, wait for processing, update document).
   */
  async syncDocumentToVectorStore(tenantId: string, documentId: string): Promise<{ ok: boolean; vectorStoreId?: string; vectorFileId?: string; error?: string }> {
    const doc = await this.prisma.knowledgeDocument.findFirst({
      where: { id: documentId, tenantId },
    });
    if (!doc) throw new NotFoundException('Knowledge document not found');

    const job = await this.prisma.knowledgeSyncJob.create({
      data: {
        tenantId,
        storeId: doc.storeId,
        documentId: doc.id,
        status: KnowledgeSyncJobStatus.PENDING,
      },
    });

    if (!this.vectorStore.isEnabled()) {
      await this.prisma.knowledgeSyncJob.update({
        where: { id: job.id },
        data: { status: KnowledgeSyncJobStatus.FAILED, errorMessage: 'Vector store not enabled' },
      });
      return { ok: false, error: 'Vector store not enabled' };
    }

    try {
      await this.prisma.knowledgeSyncJob.update({
        where: { id: job.id },
        data: { status: KnowledgeSyncJobStatus.PROCESSING, startedAt: new Date() },
      });

      const vectorStoreId = await this.vectorStore.getOrCreateVectorStoreForStore(tenantId, doc.storeId);
      if (!vectorStoreId) {
        await this.prisma.knowledgeSyncJob.update({
          where: { id: job.id },
          data: { status: KnowledgeSyncJobStatus.FAILED, errorMessage: 'Could not get or create vector store', completedAt: new Date() },
        });
        return { ok: false, error: 'Could not get or create vector store' };
      }

      const content = doc.content || ' ';
      const buffer = Buffer.from(content, 'utf-8');
      const fileName = `doc-${doc.id}.txt`;
      const metadata: Record<string, string> = {
        tenantId,
        storeId: doc.storeId,
        docType: doc.type,
        documentId: doc.id,
      };
      if (doc.branchProfileId) metadata.branchId = doc.branchProfileId;

      const uploaded = await this.vectorStore.uploadAndAttach(vectorStoreId, buffer, fileName, metadata);
      if (!uploaded) {
        await this.prisma.knowledgeSyncJob.update({
          where: { id: job.id },
          data: { status: KnowledgeSyncJobStatus.FAILED, errorMessage: 'Upload failed', completedAt: new Date() },
        });
        return { ok: false, error: 'Upload failed' };
      }

      const status = await this.vectorStore.waitUntilProcessed(vectorStoreId, uploaded.vectorFileId);
      if (status !== 'completed') {
        await this.prisma.knowledgeSyncJob.update({
          where: { id: job.id },
          data: { status: KnowledgeSyncJobStatus.FAILED, errorMessage: 'Processing failed', completedAt: new Date() },
        });
        return { ok: false, error: 'Processing failed' };
      }

      await this.prisma.knowledgeDocument.update({
        where: { id: documentId },
        data: { vectorStoreId, vectorFileId: uploaded.vectorFileId },
      });
      await this.prisma.knowledgeSyncJob.update({
        where: { id: job.id },
        data: {
          status: KnowledgeSyncJobStatus.COMPLETED,
          vectorStoreId,
          vectorFileId: uploaded.vectorFileId,
          completedAt: new Date(),
        },
      });
      return { ok: true, vectorStoreId, vectorFileId: uploaded.vectorFileId };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      await this.prisma.knowledgeSyncJob.update({
        where: { id: job.id },
        data: { status: KnowledgeSyncJobStatus.FAILED, errorMessage: message, completedAt: new Date() },
      });
      return { ok: false, error: message };
    }
  }
}
