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
exports.AnalyticsController = void 0;
const common_1 = require("@nestjs/common");
const throttler_1 = require("@nestjs/throttler");
const client_1 = require("@prisma/client");
const analytics_service_1 = require("./analytics.service");
const call_events_service_1 = require("./call-events.service");
const call_outcome_service_1 = require("./call-outcome.service");
const qa_review_service_1 = require("./qa-review.service");
const update_call_outcome_dto_1 = require("./dto/update-call-outcome.dto");
const create_qa_review_dto_1 = require("./dto/create-qa-review.dto");
const tenant_id_decorator_1 = require("../../common/decorators/tenant-id.decorator");
const roles_decorator_1 = require("../../common/decorators/roles.decorator");
const zod_validation_pipe_1 = require("../../common/pipes/zod-validation.pipe");
const analytics_query_schema_1 = require("./analytics-query.schema");
const ops_validation_1 = require("../ops/ops-validation");
let AnalyticsController = class AnalyticsController {
    constructor(analytics, callEvents, callOutcome, qaReview) {
        this.analytics = analytics;
        this.callEvents = callEvents;
        this.callOutcome = callOutcome;
        this.qaReview = qaReview;
    }
    parseDates(query) {
        return {
            from: query.from ? new Date(query.from) : undefined,
            to: query.to ? new Date(query.to) : undefined,
        };
    }
    getOverview(tenantId, query) {
        const { from, to } = this.parseDates(query);
        return this.analytics.getOverview(tenantId, from, to);
    }
    getAgentMetrics(tenantId, query) {
        const { from, to } = this.parseDates(query);
        return this.analytics.getAgentMetrics(tenantId, from, to);
    }
    getStoreMetrics(tenantId, query) {
        const { from, to } = this.parseDates(query);
        return this.analytics.getStoreMetrics(tenantId, from, to);
    }
    getToolMetrics(tenantId, query) {
        const { from, to } = this.parseDates(query);
        return this.analytics.getToolMetrics(tenantId, from, to);
    }
    getCallEvents(tenantId, id) {
        return this.callEvents.getByCallSession(id, tenantId);
    }
    updateCallOutcome(tenantId, id, body) {
        return this.callOutcome.update(tenantId, id, body);
    }
    listQaCalls(tenantId, query) {
        return this.qaReview.listCallsForQa(tenantId, {
            limit: query.limit,
            hasOutcome: query.hasOutcome === 'true' ? true : query.hasOutcome === 'false' ? false : undefined,
        });
    }
    getQaCallDetail(tenantId, id) {
        return this.qaReview.getQaDetail(id, tenantId);
    }
    submitQaReview(tenantId, id, body) {
        return this.qaReview.submitReview(tenantId, id, body);
    }
};
exports.AnalyticsController = AnalyticsController;
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 60, ttl: 60_000 } }),
    (0, common_1.Get)('analytics/overview'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Query)(new zod_validation_pipe_1.ZodValidationPipe(analytics_query_schema_1.analyticsFilterQuerySchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, void 0]),
    __metadata("design:returntype", void 0)
], AnalyticsController.prototype, "getOverview", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 60, ttl: 60_000 } }),
    (0, common_1.Get)('analytics/agents'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Query)(new zod_validation_pipe_1.ZodValidationPipe(analytics_query_schema_1.analyticsFilterQuerySchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, void 0]),
    __metadata("design:returntype", void 0)
], AnalyticsController.prototype, "getAgentMetrics", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 60, ttl: 60_000 } }),
    (0, common_1.Get)('analytics/stores'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Query)(new zod_validation_pipe_1.ZodValidationPipe(analytics_query_schema_1.analyticsFilterQuerySchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, void 0]),
    __metadata("design:returntype", void 0)
], AnalyticsController.prototype, "getStoreMetrics", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 60, ttl: 60_000 } }),
    (0, common_1.Get)('analytics/tools'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Query)(new zod_validation_pipe_1.ZodValidationPipe(analytics_query_schema_1.analyticsFilterQuerySchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, void 0]),
    __metadata("design:returntype", void 0)
], AnalyticsController.prototype, "getToolMetrics", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 120, ttl: 60_000 } }),
    (0, common_1.Get)('calls/:id/events'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id', new zod_validation_pipe_1.ZodValidationPipe(ops_validation_1.cuidParamSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], AnalyticsController.prototype, "getCallEvents", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 30, ttl: 60_000 } }),
    (0, common_1.Patch)('calls/:id/outcome'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id', new zod_validation_pipe_1.ZodValidationPipe(ops_validation_1.cuidParamSchema))),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, update_call_outcome_dto_1.UpdateCallOutcomeDto]),
    __metadata("design:returntype", void 0)
], AnalyticsController.prototype, "updateCallOutcome", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 60, ttl: 60_000 } }),
    (0, common_1.Get)('qa/calls'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Query)(new zod_validation_pipe_1.ZodValidationPipe(analytics_query_schema_1.qaCallsListQuerySchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, void 0]),
    __metadata("design:returntype", void 0)
], AnalyticsController.prototype, "listQaCalls", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 60, ttl: 60_000 } }),
    (0, common_1.Get)('qa/calls/:id'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id', new zod_validation_pipe_1.ZodValidationPipe(ops_validation_1.cuidParamSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], AnalyticsController.prototype, "getQaCallDetail", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 30, ttl: 60_000 } }),
    (0, common_1.Post)('qa/calls/:id/review'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id', new zod_validation_pipe_1.ZodValidationPipe(ops_validation_1.cuidParamSchema))),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, create_qa_review_dto_1.CreateQaReviewDto]),
    __metadata("design:returntype", void 0)
], AnalyticsController.prototype, "submitQaReview", null);
exports.AnalyticsController = AnalyticsController = __decorate([
    (0, common_1.Controller)(),
    (0, roles_decorator_1.Roles)(client_1.UserRole.MANAGER),
    __metadata("design:paramtypes", [analytics_service_1.AnalyticsService,
        call_events_service_1.CallEventsService,
        call_outcome_service_1.CallOutcomeService,
        qa_review_service_1.QaReviewService])
], AnalyticsController);
//# sourceMappingURL=analytics.controller.js.map