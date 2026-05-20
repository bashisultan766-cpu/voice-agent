"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.KnowledgeModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const knowledge_controller_1 = require("./knowledge.controller");
const faq_service_1 = require("./faq.service");
const branch_profile_service_1 = require("./branch-profile.service");
const knowledge_service_1 = require("./knowledge.service");
const retrieval_service_1 = require("./retrieval.service");
const vector_store_service_1 = require("./vector-store.service");
const knowledge_ingestion_service_1 = require("./knowledge-ingestion.service");
const retrieval_orchestrator_service_1 = require("./retrieval-orchestrator.service");
let KnowledgeModule = class KnowledgeModule {
};
exports.KnowledgeModule = KnowledgeModule;
exports.KnowledgeModule = KnowledgeModule = __decorate([
    (0, common_1.Module)({
        imports: [config_1.ConfigModule],
        controllers: [knowledge_controller_1.KnowledgeController],
        providers: [
            faq_service_1.FaqService,
            branch_profile_service_1.BranchProfileService,
            knowledge_service_1.KnowledgeService,
            retrieval_service_1.RetrievalService,
            vector_store_service_1.VectorStoreService,
            knowledge_ingestion_service_1.KnowledgeIngestionService,
            retrieval_orchestrator_service_1.RetrievalOrchestratorService,
        ],
        exports: [
            faq_service_1.FaqService,
            branch_profile_service_1.BranchProfileService,
            knowledge_service_1.KnowledgeService,
            retrieval_service_1.RetrievalService,
            vector_store_service_1.VectorStoreService,
            knowledge_ingestion_service_1.KnowledgeIngestionService,
            retrieval_orchestrator_service_1.RetrievalOrchestratorService,
        ],
    })
], KnowledgeModule);
//# sourceMappingURL=knowledge.module.js.map