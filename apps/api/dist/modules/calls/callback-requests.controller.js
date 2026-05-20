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
exports.CallbackRequestsController = void 0;
const common_1 = require("@nestjs/common");
const throttler_1 = require("@nestjs/throttler");
const client_1 = require("@prisma/client");
const tenant_id_decorator_1 = require("../../common/decorators/tenant-id.decorator");
const roles_decorator_1 = require("../../common/decorators/roles.decorator");
const zod_validation_pipe_1 = require("../../common/pipes/zod-validation.pipe");
const callback_requests_service_1 = require("./callback-requests.service");
const callback_requests_validation_1 = require("./callback-requests-validation");
const ops_validation_1 = require("../ops/ops-validation");
let CallbackRequestsController = class CallbackRequestsController {
    constructor(callbacks) {
        this.callbacks = callbacks;
    }
    list(tenantId, query) {
        return this.callbacks.listForTenant(tenantId, {
            status: query.status,
            limit: query.limit,
        });
    }
    updateStatus(tenantId, id, body) {
        const status = body.status ?? client_1.CallbackRequestStatus.IN_PROGRESS;
        return this.callbacks.updateStatus(tenantId, id, status);
    }
};
exports.CallbackRequestsController = CallbackRequestsController;
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 60, ttl: 60_000 } }),
    (0, common_1.Get)(),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Query)(new zod_validation_pipe_1.ZodValidationPipe(callback_requests_validation_1.callbackListQuerySchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, void 0]),
    __metadata("design:returntype", void 0)
], CallbackRequestsController.prototype, "list", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 30, ttl: 60_000 } }),
    (0, common_1.Patch)(':id/status'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Param)('id', new zod_validation_pipe_1.ZodValidationPipe(ops_validation_1.cuidParamSchema))),
    __param(2, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(callback_requests_validation_1.callbackPatchStatusBodySchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, void 0]),
    __metadata("design:returntype", void 0)
], CallbackRequestsController.prototype, "updateStatus", null);
exports.CallbackRequestsController = CallbackRequestsController = __decorate([
    (0, common_1.Controller)('calls/callback-requests'),
    (0, roles_decorator_1.Roles)(client_1.UserRole.MANAGER),
    __metadata("design:paramtypes", [callback_requests_service_1.CallbackRequestsService])
], CallbackRequestsController);
//# sourceMappingURL=callback-requests.controller.js.map