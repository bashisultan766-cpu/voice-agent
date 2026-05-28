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
exports.AgentsController = void 0;
const common_1 = require("@nestjs/common");
const throttler_1 = require("@nestjs/throttler");
const client_1 = require("@prisma/client");
const agents_service_1 = require("./agents.service");
const shopify_agent_service_1 = require("./shopify-agent.service");
const create_agent_dto_1 = require("./dto/create-agent.dto");
const update_agent_dto_1 = require("./dto/update-agent.dto");
const tenant_id_decorator_1 = require("../../common/decorators/tenant-id.decorator");
const user_id_decorator_1 = require("../../common/decorators/user-id.decorator");
const roles_decorator_1 = require("../../common/decorators/roles.decorator");
const zod_validation_pipe_1 = require("../../common/pipes/zod-validation.pipe");
const agents_validation_1 = require("./agents-validation");
const zod_1 = require("zod");
function errorMessage(err) {
    if (err instanceof Error) {
        const r = err.getResponse?.();
        if (r && typeof r === 'object' && r !== null) {
            const msg = r.message;
            if (Array.isArray(msg) && msg.length > 0 && typeof msg[0] === 'string')
                return msg[0];
            if (typeof msg === 'string')
                return msg;
        }
        return err.message;
    }
    return String(err);
}
let AgentsController = class AgentsController {
    constructor(agentsService, shopifyAgent) {
        this.agentsService = agentsService;
        this.shopifyAgent = shopifyAgent;
    }
    async testShopifyCredentials(tenantId, dto) {
        try {
            return await this.agentsService.testShopifyConnection(tenantId, null, dto);
        }
        catch (err) {
            const message = errorMessage(err);
            return { success: false, message, code: 'INVALID_TOKEN_OR_DOMAIN' };
        }
    }
    async testDatabaseCredentials(tenantId, dto) {
        try {
            return await this.agentsService.testDatabaseConnection(tenantId, null, dto);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Database connection test failed.';
            return { success: false, message };
        }
    }
    async testTwilioCredentials(tenantId, dto) {
        try {
            return await this.agentsService.testTwilioConnection(tenantId, null, dto);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Twilio connection test failed.';
            return { success: false, message };
        }
    }
    async testOpenAICredentials(tenantId, dto) {
        try {
            return await this.agentsService.testOpenAIConnection(tenantId, null, dto);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'OpenAI connection test failed.';
            return { success: false, message };
        }
    }
    async testElevenLabsCredentials(tenantId, dto) {
        try {
            return await this.agentsService.testElevenLabsConnection(tenantId, null, dto);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'ElevenLabs connection test failed.';
            return { success: false, message };
        }
    }
    create(tenantId, userId, dto) {
        return this.agentsService.create(tenantId, dto, userId);
    }
    async findAll(tenantId) {
        try {
            return await this.agentsService.findAll(tenantId);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (message.includes('connect') || message.includes('Connection') || message.includes('ECONNREFUSED')) {
                throw new common_1.BadRequestException('Database is not available. Check that PostgreSQL is running and DATABASE_URL is set.');
            }
            if (message.includes('does not exist') || message.includes('relation') || message.includes('table') || message.includes('Unknown table')) {
                throw new common_1.BadRequestException('Database schema is missing. Run: pnpm db:migrate');
            }
            throw new common_1.InternalServerErrorException('Unable to load agents. Please try again or check the API logs.');
        }
    }
    getAnalytics(tenantId, id) {
        return this.agentsService.getAgentAnalytics(tenantId, id);
    }
    getLogs(tenantId, id, query) {
        return this.agentsService.getAgentLogs(tenantId, id, query.limit ?? 50);
    }
    getCatalogReadiness(tenantId, id) {
        return this.agentsService.getCatalogReadiness(tenantId, id);
    }
    testAi(tenantId, id, dto) {
        return this.agentsService.testAiBehavior(tenantId, id, dto?.sampleQuery ?? 'Where is my order?');
    }
    getRuntimePromptPreview(tenantId, id) {
        return this.agentsService.getRuntimePromptPreview(tenantId, id);
    }
    findOne(tenantId, id) {
        return this.agentsService.findOne(tenantId, id);
    }
    getRuntimeDebug(tenantId, id, callSessionId) {
        return this.agentsService.getRuntimeDebug(tenantId, id, callSessionId);
    }
    getReadiness(tenantId, id) {
        return this.agentsService.getAgentReadiness(tenantId, id);
    }
    getPersistenceDiagnostics(tenantId, id) {
        return this.agentsService.getPersistenceDiagnostics(tenantId, id);
    }
    sendTestEmail(tenantId, id, body) {
        return this.agentsService.sendTestEmail(tenantId, id, body);
    }
    configureTwilioWebhook(tenantId, id, _dto) {
        return this.agentsService.configureTwilioWebhook(tenantId, id);
    }
    runSmokeTest(tenantId, id, dto) {
        return this.agentsService.runSmokeTest(tenantId, id, {
            sampleSpeechResult: dto.sampleSpeechResult,
        });
    }
    goLive(tenantId, userId, id) {
        return this.agentsService.goLive(tenantId, id, userId);
    }
    syncSecretsFromSettings(tenantId, userId, id) {
        return this.agentsService.syncSecretsFromWorkspace(tenantId, id, userId);
    }
    patchCredentials(tenantId, userId, id, body) {
        return this.agentsService.patchCredentials(tenantId, id, body, userId);
    }
    updateStatus(tenantId, userId, id, body) {
        return this.agentsService.updateStatus(tenantId, id, body.status, userId);
    }
    update(tenantId, userId, id, dto) {
        return this.agentsService.update(tenantId, id, dto, userId);
    }
    remove(tenantId, userId, id) {
        return this.agentsService.remove(tenantId, id, userId);
    }
    async testShopify(tenantId, id, dto) {
        try {
            return await this.agentsService.testShopifyConnection(tenantId, id, dto);
        }
        catch (err) {
            const message = errorMessage(err);
            return { success: false, message, code: 'INVALID_TOKEN_OR_DOMAIN' };
        }
    }
    testDatabase(tenantId, id, dto) {
        return this.agentsService.testDatabaseConnection(tenantId, id, dto);
    }
    testTwilio(tenantId, id, dto) {
        return this.agentsService.testTwilioConnection(tenantId, id, dto);
    }
    testOpenAI(tenantId, id, dto) {
        return this.agentsService.testOpenAIConnection(tenantId, id, dto);
    }
    testElevenLabs(tenantId, id, dto) {
        return this.agentsService.testElevenLabsConnection(tenantId, id, dto);
    }
    debugShopifySearch(tenantId, id, dto) {
        return this.shopifyAgent.debugProductSearch(tenantId, id, dto.query);
    }
};
exports.AgentsController = AgentsController;
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 10, ttl: 60_000 } }),
    (0, roles_decorator_1.Roles)(client_1.UserRole.MANAGER),
    (0, common_1.Post)('test-credentials/shopify'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.testShopifyCredentialsSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, void 0]),
    __metadata("design:returntype", Promise)
], AgentsController.prototype, "testShopifyCredentials", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 10, ttl: 60_000 } }),
    (0, roles_decorator_1.Roles)(client_1.UserRole.MANAGER),
    (0, common_1.Post)('test-credentials/database'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.testDatabaseCredentialsSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, void 0]),
    __metadata("design:returntype", Promise)
], AgentsController.prototype, "testDatabaseCredentials", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 10, ttl: 60_000 } }),
    (0, roles_decorator_1.Roles)(client_1.UserRole.MANAGER),
    (0, common_1.Post)('test-credentials/twilio'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.testTwilioCredentialsSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, void 0]),
    __metadata("design:returntype", Promise)
], AgentsController.prototype, "testTwilioCredentials", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 10, ttl: 60_000 } }),
    (0, roles_decorator_1.Roles)(client_1.UserRole.MANAGER),
    (0, common_1.Post)('test-credentials/openai'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.testOpenAiCredentialsSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, void 0]),
    __metadata("design:returntype", Promise)
], AgentsController.prototype, "testOpenAICredentials", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 10, ttl: 60_000 } }),
    (0, roles_decorator_1.Roles)(client_1.UserRole.MANAGER),
    (0, common_1.Post)('test-credentials/elevenlabs'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.testElevenLabsCredentialsSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, void 0]),
    __metadata("design:returntype", Promise)
], AgentsController.prototype, "testElevenLabsCredentials", null);
__decorate([
    (0, roles_decorator_1.Roles)(client_1.UserRole.MANAGER),
    (0, common_1.Post)(),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, user_id_decorator_1.UserId)()),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, create_agent_dto_1.CreateAgentDto]),
    __metadata("design:returntype", void 0)
], AgentsController.prototype, "create", null);
__decorate([
    (0, roles_decorator_1.Roles)(client_1.UserRole.SUPPORT),
    (0, common_1.Get)(),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AgentsController.prototype, "findAll", null);
__decorate([
    (0, roles_decorator_1.Roles)(client_1.UserRole.SUPPORT),
    (0, common_1.Get)(':id/analytics'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id', new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.cuidParamSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], AgentsController.prototype, "getAnalytics", null);
__decorate([
    (0, roles_decorator_1.Roles)(client_1.UserRole.SUPPORT),
    (0, common_1.Get)(':id/logs'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id', new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.cuidParamSchema))),
    __param(2, (0, common_1.Query)(new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.logsQuerySchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, void 0]),
    __metadata("design:returntype", void 0)
], AgentsController.prototype, "getLogs", null);
__decorate([
    (0, roles_decorator_1.Roles)(client_1.UserRole.SUPPORT),
    (0, common_1.Get)(':id/catalog-readiness'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id', new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.cuidParamSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], AgentsController.prototype, "getCatalogReadiness", null);
__decorate([
    (0, roles_decorator_1.Roles)(client_1.UserRole.SUPPORT),
    (0, common_1.Post)(':id/test-ai'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id', new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.cuidParamSchema))),
    __param(2, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.testAiBehaviorBodySchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, void 0]),
    __metadata("design:returntype", void 0)
], AgentsController.prototype, "testAi", null);
__decorate([
    (0, roles_decorator_1.Roles)(client_1.UserRole.MANAGER),
    (0, common_1.Get)(':id/runtime-prompt-preview'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id', new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.cuidParamSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], AgentsController.prototype, "getRuntimePromptPreview", null);
__decorate([
    (0, roles_decorator_1.Roles)(client_1.UserRole.SUPPORT),
    (0, common_1.Get)(':id'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id', new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.cuidParamSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], AgentsController.prototype, "findOne", null);
__decorate([
    (0, common_1.Get)(':id/runtime-debug'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id', new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.cuidParamSchema))),
    __param(2, (0, common_1.Query)('callSessionId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", void 0)
], AgentsController.prototype, "getRuntimeDebug", null);
__decorate([
    (0, roles_decorator_1.Roles)(client_1.UserRole.SUPPORT),
    (0, common_1.Get)(':id/readiness'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id', new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.cuidParamSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], AgentsController.prototype, "getReadiness", null);
__decorate([
    (0, roles_decorator_1.Roles)(client_1.UserRole.ADMIN),
    (0, common_1.Get)(':id/persistence-diagnostics'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id', new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.cuidParamSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], AgentsController.prototype, "getPersistenceDiagnostics", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 10, ttl: 60_000 } }),
    (0, roles_decorator_1.Roles)(client_1.UserRole.MANAGER),
    (0, common_1.Post)(':id/test-email'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id', new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.cuidParamSchema))),
    __param(2, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.testAgentEmailBodySchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, void 0]),
    __metadata("design:returntype", void 0)
], AgentsController.prototype, "sendTestEmail", null);
__decorate([
    (0, roles_decorator_1.Roles)(client_1.UserRole.OWNER, client_1.UserRole.ADMIN),
    (0, common_1.Post)(':id/configure-twilio-webhook'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id', new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.cuidParamSchema))),
    __param(2, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.configureTwilioWebhookBodySchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, void 0]),
    __metadata("design:returntype", void 0)
], AgentsController.prototype, "configureTwilioWebhook", null);
__decorate([
    (0, roles_decorator_1.Roles)(client_1.UserRole.MANAGER),
    (0, common_1.Post)(':id/smoke-test'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id', new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.cuidParamSchema))),
    __param(2, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.smokeTestBodySchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, void 0]),
    __metadata("design:returntype", void 0)
], AgentsController.prototype, "runSmokeTest", null);
__decorate([
    (0, roles_decorator_1.Roles)(client_1.UserRole.OWNER, client_1.UserRole.ADMIN),
    (0, common_1.Post)(':id/go-live'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, user_id_decorator_1.UserId)()),
    __param(2, (0, common_1.Param)('id', new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.cuidParamSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", void 0)
], AgentsController.prototype, "goLive", null);
__decorate([
    (0, roles_decorator_1.Roles)(client_1.UserRole.MANAGER),
    (0, common_1.Post)(':id/sync-secrets-from-settings'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, user_id_decorator_1.UserId)()),
    __param(2, (0, common_1.Param)('id', new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.cuidParamSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", void 0)
], AgentsController.prototype, "syncSecretsFromSettings", null);
__decorate([
    (0, roles_decorator_1.Roles)(client_1.UserRole.MANAGER),
    (0, common_1.Patch)(':id/credentials'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, user_id_decorator_1.UserId)()),
    __param(2, (0, common_1.Param)('id', new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.cuidParamSchema))),
    __param(3, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.patchAgentCredentialsBodySchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, void 0]),
    __metadata("design:returntype", void 0)
], AgentsController.prototype, "patchCredentials", null);
__decorate([
    (0, roles_decorator_1.Roles)(client_1.UserRole.MANAGER),
    (0, common_1.Patch)(':id/status'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, user_id_decorator_1.UserId)()),
    __param(2, (0, common_1.Param)('id', new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.cuidParamSchema))),
    __param(3, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.updateAgentStatusBodySchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, void 0]),
    __metadata("design:returntype", void 0)
], AgentsController.prototype, "updateStatus", null);
__decorate([
    (0, roles_decorator_1.Roles)(client_1.UserRole.MANAGER),
    (0, common_1.Patch)(':id'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, user_id_decorator_1.UserId)()),
    __param(2, (0, common_1.Param)('id', new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.cuidParamSchema))),
    __param(3, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, update_agent_dto_1.UpdateAgentDto]),
    __metadata("design:returntype", void 0)
], AgentsController.prototype, "update", null);
__decorate([
    (0, roles_decorator_1.Roles)(client_1.UserRole.ADMIN),
    (0, common_1.Delete)(':id'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, user_id_decorator_1.UserId)()),
    __param(2, (0, common_1.Param)('id', new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.cuidParamSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", void 0)
], AgentsController.prototype, "remove", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 12, ttl: 60_000 } }),
    (0, roles_decorator_1.Roles)(client_1.UserRole.MANAGER),
    (0, common_1.Post)(':id/test-shopify'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id', new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.cuidParamSchema))),
    __param(2, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.testShopifyCredentialsSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, void 0]),
    __metadata("design:returntype", Promise)
], AgentsController.prototype, "testShopify", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 12, ttl: 60_000 } }),
    (0, roles_decorator_1.Roles)(client_1.UserRole.MANAGER),
    (0, common_1.Post)(':id/test-database'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id', new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.cuidParamSchema))),
    __param(2, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.testDatabaseCredentialsSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, void 0]),
    __metadata("design:returntype", void 0)
], AgentsController.prototype, "testDatabase", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 12, ttl: 60_000 } }),
    (0, roles_decorator_1.Roles)(client_1.UserRole.ADMIN),
    (0, common_1.Post)(':id/test-twilio'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id', new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.cuidParamSchema))),
    __param(2, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.testTwilioCredentialsSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, void 0]),
    __metadata("design:returntype", void 0)
], AgentsController.prototype, "testTwilio", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 12, ttl: 60_000 } }),
    (0, roles_decorator_1.Roles)(client_1.UserRole.MANAGER),
    (0, common_1.Post)(':id/test-openai'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id', new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.cuidParamSchema))),
    __param(2, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.testOpenAiCredentialsSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, void 0]),
    __metadata("design:returntype", void 0)
], AgentsController.prototype, "testOpenAI", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 12, ttl: 60_000 } }),
    (0, roles_decorator_1.Roles)(client_1.UserRole.MANAGER),
    (0, common_1.Post)(':id/test-elevenlabs'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id', new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.cuidParamSchema))),
    __param(2, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.testElevenLabsCredentialsSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, void 0]),
    __metadata("design:returntype", void 0)
], AgentsController.prototype, "testElevenLabs", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 20, ttl: 60_000 } }),
    (0, roles_decorator_1.Roles)(client_1.UserRole.MANAGER),
    (0, common_1.Post)(':id/debug-shopify-search'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id', new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.cuidParamSchema))),
    __param(2, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(agents_validation_1.debugShopifySearchBodySchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, void 0]),
    __metadata("design:returntype", void 0)
], AgentsController.prototype, "debugShopifySearch", null);
exports.AgentsController = AgentsController = __decorate([
    (0, common_1.Controller)('agents'),
    (0, roles_decorator_1.Roles)(client_1.UserRole.MANAGER),
    __metadata("design:paramtypes", [agents_service_1.AgentsService,
        shopify_agent_service_1.ShopifyAgentService])
], AgentsController);
//# sourceMappingURL=agents.controller.js.map