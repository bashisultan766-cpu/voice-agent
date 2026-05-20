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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.KnowledgeController = void 0;
const common_1 = require("@nestjs/common");
const throttler_1 = require("@nestjs/throttler");
const client_1 = require("@prisma/client");
const faq_service_1 = require("./faq.service");
const branch_profile_service_1 = require("./branch-profile.service");
const knowledge_service_1 = require("./knowledge.service");
const retrieval_service_1 = require("./retrieval.service");
const knowledge_ingestion_service_1 = require("./knowledge-ingestion.service");
const retrieval_orchestrator_service_1 = require("./retrieval-orchestrator.service");
const create_faq_dto_1 = require("./dto/create-faq.dto");
const update_faq_dto_1 = require("./dto/update-faq.dto");
const create_branch_profile_dto_1 = require("./dto/create-branch-profile.dto");
const update_branch_profile_dto_1 = require("./dto/update-branch-profile.dto");
const create_knowledge_document_dto_1 = require("./dto/create-knowledge-document.dto");
const update_knowledge_document_dto_1 = require("./dto/update-knowledge-document.dto");
const search_knowledge_dto_1 = require("./dto/search-knowledge.dto");
const client_2 = require("@prisma/client");
const tenant_id_decorator_1 = require("../../common/decorators/tenant-id.decorator");
const roles_decorator_1 = require("../../common/decorators/roles.decorator");
let KnowledgeController = class KnowledgeController {
    constructor(faqService, branchProfileService, knowledgeService, retrievalService, knowledgeIngestion, retrievalOrchestrator) {
        this.faqService = faqService;
        this.branchProfileService = branchProfileService;
        this.knowledgeService = knowledgeService;
        this.retrievalService = retrievalService;
        this.knowledgeIngestion = knowledgeIngestion;
        this.retrievalOrchestrator = retrievalOrchestrator;
    }
    createFaq(tenantId, dto) {
        return this.faqService.create(tenantId, dto);
    }
    listFaqs(tenantId, storeId, branchProfileId, isActive) {
        return this.faqService.findAll(tenantId, storeId, branchProfileId, isActive === 'true' ? true : isActive === 'false' ? false : undefined);
    }
    getFaq(tenantId, id) {
        return this.faqService.findOne(tenantId, id);
    }
    updateFaq(tenantId, id, dto) {
        return this.faqService.update(tenantId, id, dto);
    }
    deleteFaq(tenantId, id) {
        return this.faqService.remove(tenantId, id);
    }
    createBranch(tenantId, dto) {
        return this.branchProfileService.create(tenantId, dto);
    }
    listBranches(tenantId, storeId, city, isActive) {
        return this.branchProfileService.findAll(tenantId, storeId, city, isActive === 'true' ? true : isActive === 'false' ? false : undefined);
    }
    getBranch(tenantId, id) {
        return this.branchProfileService.findOne(tenantId, id);
    }
    updateBranch(tenantId, id, dto) {
        return this.branchProfileService.update(tenantId, id, dto);
    }
    deleteBranch(tenantId, id) {
        return this.branchProfileService.remove(tenantId, id);
    }
    createDocument(tenantId, dto) {
        return this.knowledgeService.create(tenantId, dto);
    }
    listDocuments(tenantId, storeId, type, status) {
        return this.knowledgeService.findAll(tenantId, storeId, type, status);
    }
    getDocument(tenantId, id) {
        return this.knowledgeService.findOne(tenantId, id);
    }
    updateDocument(tenantId, id, dto) {
        return this.knowledgeService.update(tenantId, id, dto);
    }
    deleteDocument(tenantId, id) {
        return this.knowledgeService.remove(tenantId, id);
    }
    async reindexDocument(tenantId, id) {
        return this.knowledgeIngestion.syncDocumentToVectorStore(tenantId, id);
    }
    archiveDocument(tenantId, id) {
        return this.knowledgeService.update(tenantId, id, { status: client_2.KnowledgeStatus.ARCHIVED });
    }
    async search(tenantId, dto) {
        if (!dto.storeId) {
            return { ok: true, source: 'faq', items: [], voiceSummary: 'Provide storeId to search.' };
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
};
exports.KnowledgeController = KnowledgeController;
__decorate([
    (0, common_1.Post)('faqs'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, create_faq_dto_1.CreateFaqDto]),
    __metadata("design:returntype", void 0)
], KnowledgeController.prototype, "createFaq", null);
__decorate([
    (0, common_1.Get)('faqs'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Query)('storeId')),
    __param(2, (0, common_1.Query)('branchProfileId')),
    __param(3, (0, common_1.Query)('isActive')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String]),
    __metadata("design:returntype", void 0)
], KnowledgeController.prototype, "listFaqs", null);
__decorate([
    (0, common_1.Get)('faqs/:id'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], KnowledgeController.prototype, "getFaq", null);
__decorate([
    (0, common_1.Patch)('faqs/:id'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, update_faq_dto_1.UpdateFaqDto]),
    __metadata("design:returntype", void 0)
], KnowledgeController.prototype, "updateFaq", null);
__decorate([
    (0, common_1.Delete)('faqs/:id'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], KnowledgeController.prototype, "deleteFaq", null);
__decorate([
    (0, common_1.Post)('branches'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, create_branch_profile_dto_1.CreateBranchProfileDto]),
    __metadata("design:returntype", void 0)
], KnowledgeController.prototype, "createBranch", null);
__decorate([
    (0, common_1.Get)('branches'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Query)('storeId')),
    __param(2, (0, common_1.Query)('city')),
    __param(3, (0, common_1.Query)('isActive')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String]),
    __metadata("design:returntype", void 0)
], KnowledgeController.prototype, "listBranches", null);
__decorate([
    (0, common_1.Get)('branches/:id'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], KnowledgeController.prototype, "getBranch", null);
__decorate([
    (0, common_1.Patch)('branches/:id'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, update_branch_profile_dto_1.UpdateBranchProfileDto]),
    __metadata("design:returntype", void 0)
], KnowledgeController.prototype, "updateBranch", null);
__decorate([
    (0, common_1.Delete)('branches/:id'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], KnowledgeController.prototype, "deleteBranch", null);
__decorate([
    (0, common_1.Post)('documents'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, create_knowledge_document_dto_1.CreateKnowledgeDocumentDto]),
    __metadata("design:returntype", void 0)
], KnowledgeController.prototype, "createDocument", null);
__decorate([
    (0, common_1.Get)('documents'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Query)('storeId')),
    __param(2, (0, common_1.Query)('type')),
    __param(3, (0, common_1.Query)('status')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String]),
    __metadata("design:returntype", void 0)
], KnowledgeController.prototype, "listDocuments", null);
__decorate([
    (0, common_1.Get)('documents/:id'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], KnowledgeController.prototype, "getDocument", null);
__decorate([
    (0, common_1.Patch)('documents/:id'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, update_knowledge_document_dto_1.UpdateKnowledgeDocumentDto]),
    __metadata("design:returntype", void 0)
], KnowledgeController.prototype, "updateDocument", null);
__decorate([
    (0, common_1.Delete)('documents/:id'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], KnowledgeController.prototype, "deleteDocument", null);
__decorate([
    (0, common_1.Post)('documents/:id/reindex'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], KnowledgeController.prototype, "reindexDocument", null);
__decorate([
    (0, common_1.Post)('documents/:id/archive'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], KnowledgeController.prototype, "archiveDocument", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 40, ttl: 60_000 } }),
    (0, common_1.Post)('search'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, search_knowledge_dto_1.SearchKnowledgeDto]),
    __metadata("design:returntype", Promise)
], KnowledgeController.prototype, "search", null);
exports.KnowledgeController = KnowledgeController = __decorate([
    (0, common_1.Controller)('knowledge'),
    (0, roles_decorator_1.Roles)(client_1.UserRole.MANAGER),
    __metadata("design:paramtypes", [faq_service_1.FaqService,
        branch_profile_service_1.BranchProfileService,
        knowledge_service_1.KnowledgeService,
        retrieval_service_1.RetrievalService,
        knowledge_ingestion_service_1.KnowledgeIngestionService,
        retrieval_orchestrator_service_1.RetrievalOrchestratorService])
], KnowledgeController);
//# sourceMappingURL=knowledge.controller.js.map