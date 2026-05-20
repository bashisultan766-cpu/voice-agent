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
exports.VoiceConfigCheckController = void 0;
const common_1 = require("@nestjs/common");
const throttler_1 = require("@nestjs/throttler");
const client_1 = require("@prisma/client");
const voice_config_check_service_1 = require("./voice-config-check.service");
const tenant_id_decorator_1 = require("../../../common/decorators/tenant-id.decorator");
const roles_decorator_1 = require("../../../common/decorators/roles.decorator");
let VoiceConfigCheckController = class VoiceConfigCheckController {
    constructor(checkSvc) {
        this.checkSvc = checkSvc;
    }
    async configCheck(tenantId, agentIdRaw) {
        const agentId = agentIdRaw?.trim();
        if (!agentId) {
            return {
                error: 'agentId_required',
                message: 'Pass agentId as a query parameter.',
            };
        }
        return this.checkSvc.check(tenantId, agentId);
    }
};
exports.VoiceConfigCheckController = VoiceConfigCheckController;
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 30, ttl: 60_000 } }),
    (0, common_1.Get)('config-check'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Query)('agentId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], VoiceConfigCheckController.prototype, "configCheck", null);
exports.VoiceConfigCheckController = VoiceConfigCheckController = __decorate([
    (0, common_1.Controller)('voice'),
    (0, roles_decorator_1.Roles)(client_1.UserRole.MANAGER),
    __metadata("design:paramtypes", [voice_config_check_service_1.VoiceConfigCheckService])
], VoiceConfigCheckController);
//# sourceMappingURL=voice-config-check.controller.js.map