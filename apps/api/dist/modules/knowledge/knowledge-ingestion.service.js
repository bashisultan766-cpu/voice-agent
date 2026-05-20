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
exports.KnowledgeIngestionService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../database/prisma.service");
const vector_store_service_1 = require("./vector-store.service");
const client_1 = require("@prisma/client");
let KnowledgeIngestionService = class KnowledgeIngestionService {
    constructor(prisma, vectorStore) {
        this.prisma = prisma;
        this.vectorStore = vectorStore;
    }
    async syncDocumentToVectorStore(tenantId, documentId) {
        const doc = await this.prisma.knowledgeDocument.findFirst({
            where: { id: documentId, tenantId },
        });
        if (!doc)
            throw new common_1.NotFoundException('Knowledge document not found');
        const job = await this.prisma.knowledgeSyncJob.create({
            data: {
                tenantId,
                storeId: doc.storeId,
                documentId: doc.id,
                status: client_1.KnowledgeSyncJobStatus.PENDING,
            },
        });
        if (!this.vectorStore.isEnabled()) {
            await this.prisma.knowledgeSyncJob.update({
                where: { id: job.id },
                data: { status: client_1.KnowledgeSyncJobStatus.FAILED, errorMessage: 'Vector store not enabled' },
            });
            return { ok: false, error: 'Vector store not enabled' };
        }
        try {
            await this.prisma.knowledgeSyncJob.update({
                where: { id: job.id },
                data: { status: client_1.KnowledgeSyncJobStatus.PROCESSING, startedAt: new Date() },
            });
            const vectorStoreId = await this.vectorStore.getOrCreateVectorStoreForStore(tenantId, doc.storeId);
            if (!vectorStoreId) {
                await this.prisma.knowledgeSyncJob.update({
                    where: { id: job.id },
                    data: { status: client_1.KnowledgeSyncJobStatus.FAILED, errorMessage: 'Could not get or create vector store', completedAt: new Date() },
                });
                return { ok: false, error: 'Could not get or create vector store' };
            }
            const content = doc.content || ' ';
            const buffer = Buffer.from(content, 'utf-8');
            const fileName = `doc-${doc.id}.txt`;
            const metadata = {
                tenantId,
                storeId: doc.storeId,
                docType: doc.type,
                documentId: doc.id,
            };
            if (doc.branchProfileId)
                metadata.branchId = doc.branchProfileId;
            const uploaded = await this.vectorStore.uploadAndAttach(vectorStoreId, buffer, fileName, metadata);
            if (!uploaded) {
                await this.prisma.knowledgeSyncJob.update({
                    where: { id: job.id },
                    data: { status: client_1.KnowledgeSyncJobStatus.FAILED, errorMessage: 'Upload failed', completedAt: new Date() },
                });
                return { ok: false, error: 'Upload failed' };
            }
            const status = await this.vectorStore.waitUntilProcessed(vectorStoreId, uploaded.vectorFileId);
            if (status !== 'completed') {
                await this.prisma.knowledgeSyncJob.update({
                    where: { id: job.id },
                    data: { status: client_1.KnowledgeSyncJobStatus.FAILED, errorMessage: 'Processing failed', completedAt: new Date() },
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
                    status: client_1.KnowledgeSyncJobStatus.COMPLETED,
                    vectorStoreId,
                    vectorFileId: uploaded.vectorFileId,
                    completedAt: new Date(),
                },
            });
            return { ok: true, vectorStoreId, vectorFileId: uploaded.vectorFileId };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            await this.prisma.knowledgeSyncJob.update({
                where: { id: job.id },
                data: { status: client_1.KnowledgeSyncJobStatus.FAILED, errorMessage: message, completedAt: new Date() },
            });
            return { ok: false, error: message };
        }
    }
};
exports.KnowledgeIngestionService = KnowledgeIngestionService;
exports.KnowledgeIngestionService = KnowledgeIngestionService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        vector_store_service_1.VectorStoreService])
], KnowledgeIngestionService);
//# sourceMappingURL=knowledge-ingestion.service.js.map