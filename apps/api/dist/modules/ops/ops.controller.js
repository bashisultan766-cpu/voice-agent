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
exports.OpsController = void 0;
const common_1 = require("@nestjs/common");
const throttler_1 = require("@nestjs/throttler");
const client_1 = require("@prisma/client");
const tenant_id_decorator_1 = require("../../common/decorators/tenant-id.decorator");
const roles_decorator_1 = require("../../common/decorators/roles.decorator");
const zod_validation_pipe_1 = require("../../common/pipes/zod-validation.pipe");
const ops_service_1 = require("./ops.service");
const ops_validation_1 = require("./ops-validation");
let OpsController = class OpsController {
    constructor(ops) {
        this.ops = ops;
    }
    getAgents(tenantId) {
        return this.ops.getAgentsOverview(tenantId);
    }
    getCalls(tenantId) {
        return this.ops.getCalls(tenantId);
    }
    getTranscripts(tenantId, callSessionId) {
        return this.ops.getTranscripts(tenantId, callSessionId);
    }
    getCheckoutLinks(tenantId) {
        return this.ops.getCheckoutLinks(tenantId);
    }
    getLeads(tenantId) {
        return this.ops.getLeads(tenantId);
    }
    getEmailEvents(tenantId) {
        return this.ops.getEmailEvents(tenantId);
    }
    getPayments(tenantId) {
        return this.ops.getPayments(tenantId);
    }
    simulateTool(tenantId, agentId, body) {
        return this.ops.simulateToolCall(tenantId, agentId, body);
    }
    syncProducts(tenantId, agentId) {
        return this.ops.syncProductsManual(tenantId, agentId);
    }
    sendTestEmail(tenantId, agentId, body) {
        return this.ops.sendDevelopmentTestEmail(tenantId, agentId, body);
    }
    simulateBuyingFlow(tenantId, agentId, body) {
        return this.ops.simulateBuyingFlow(tenantId, agentId, body);
    }
    fullReadinessSmoke(tenantId, agentId, body) {
        return this.ops.fullReadinessSmoke(tenantId, agentId, body);
    }
};
exports.OpsController = OpsController;
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 60, ttl: 60_000 } }),
    (0, common_1.Get)('agents'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], OpsController.prototype, "getAgents", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 60, ttl: 60_000 } }),
    (0, common_1.Get)('calls'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], OpsController.prototype, "getCalls", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 120, ttl: 60_000 } }),
    (0, common_1.Get)('calls/:callSessionId/transcripts'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('callSessionId', new zod_validation_pipe_1.ZodValidationPipe(ops_validation_1.cuidParamSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], OpsController.prototype, "getTranscripts", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 60, ttl: 60_000 } }),
    (0, common_1.Get)('checkout-links'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], OpsController.prototype, "getCheckoutLinks", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 60, ttl: 60_000 } }),
    (0, common_1.Get)('leads'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], OpsController.prototype, "getLeads", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 60, ttl: 60_000 } }),
    (0, common_1.Get)('email-events'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], OpsController.prototype, "getEmailEvents", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 60, ttl: 60_000 } }),
    (0, common_1.Get)('payments'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], OpsController.prototype, "getPayments", null);
__decorate([
    (0, common_1.Post)('agents/:agentId/simulate-tool'),
    (0, roles_decorator_1.Roles)(client_1.UserRole.ADMIN),
    (0, throttler_1.Throttle)({ default: { limit: 20, ttl: 60_000 } }),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('agentId', new zod_validation_pipe_1.ZodValidationPipe(ops_validation_1.cuidParamSchema))),
    __param(2, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(ops_validation_1.simulateToolBodySchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, void 0]),
    __metadata("design:returntype", void 0)
], OpsController.prototype, "simulateTool", null);
__decorate([
    (0, common_1.Post)('agents/:agentId/sync-products'),
    (0, roles_decorator_1.Roles)(client_1.UserRole.ADMIN),
    (0, throttler_1.Throttle)({ default: { limit: 10, ttl: 60_000 } }),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('agentId', new zod_validation_pipe_1.ZodValidationPipe(ops_validation_1.cuidParamSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], OpsController.prototype, "syncProducts", null);
__decorate([
    (0, common_1.Post)('agents/:agentId/test-email'),
    (0, roles_decorator_1.Roles)(client_1.UserRole.ADMIN),
    (0, throttler_1.Throttle)({ default: { limit: 15, ttl: 60_000 } }),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('agentId', new zod_validation_pipe_1.ZodValidationPipe(ops_validation_1.cuidParamSchema))),
    __param(2, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(ops_validation_1.testEmailBodySchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, void 0]),
    __metadata("design:returntype", void 0)
], OpsController.prototype, "sendTestEmail", null);
__decorate([
    (0, common_1.Post)('agents/:agentId/simulate-buying-flow'),
    (0, roles_decorator_1.Roles)(client_1.UserRole.ADMIN),
    (0, throttler_1.Throttle)({ default: { limit: 8, ttl: 60_000 } }),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('agentId', new zod_validation_pipe_1.ZodValidationPipe(ops_validation_1.cuidParamSchema))),
    __param(2, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(ops_validation_1.simulateBuyingFlowBodySchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, void 0]),
    __metadata("design:returntype", void 0)
], OpsController.prototype, "simulateBuyingFlow", null);
__decorate([
    (0, common_1.Post)('agents/:agentId/full-readiness-smoke'),
    (0, roles_decorator_1.Roles)(client_1.UserRole.ADMIN),
    (0, throttler_1.Throttle)({ default: { limit: 8, ttl: 60_000 } }),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('agentId', new zod_validation_pipe_1.ZodValidationPipe(ops_validation_1.cuidParamSchema))),
    __param(2, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(ops_validation_1.fullReadinessSmokeBodySchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, void 0]),
    __metadata("design:returntype", void 0)
], OpsController.prototype, "fullReadinessSmoke", null);
exports.OpsController = OpsController = __decorate([
    (0, common_1.Controller)('ops'),
    (0, roles_decorator_1.Roles)(client_1.UserRole.SUPPORT),
    __metadata("design:paramtypes", [ops_service_1.OpsService])
], OpsController);
//# sourceMappingURL=ops.controller.js.map