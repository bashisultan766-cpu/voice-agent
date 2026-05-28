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
exports.TenantIntegrationsController = void 0;
const common_1 = require("@nestjs/common");
const throttler_1 = require("@nestjs/throttler");
const client_1 = require("@prisma/client");
const class_transformer_1 = require("class-transformer");
const class_validator_1 = require("class-validator");
const zod_validation_pipe_1 = require("../../common/pipes/zod-validation.pipe");
const tenant_integrations_service_1 = require("./tenant-integrations.service");
const tenant_integrations_validation_1 = require("./tenant-integrations-validation");
const tenant_id_decorator_1 = require("../../common/decorators/tenant-id.decorator");
const roles_decorator_1 = require("../../common/decorators/roles.decorator");
class ShopifyTestBodyDto {
}
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], ShopifyTestBodyDto.prototype, "shopDomain", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Transform)(({ value }) => (typeof value === 'string' && !value.trim() ? undefined : value)),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], ShopifyTestBodyDto.prototype, "accessToken", void 0);
class ShopifySaveBodyDto {
}
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], ShopifySaveBodyDto.prototype, "shopDomain", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Transform)(({ value }) => (typeof value === 'string' && !value.trim() ? undefined : value)),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], ShopifySaveBodyDto.prototype, "accessToken", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], ShopifySaveBodyDto.prototype, "skipConnectionTest", void 0);
class OpenaiTestBodyDto {
}
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Transform)(({ value }) => (typeof value === 'string' && !value.trim() ? undefined : value)),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], OpenaiTestBodyDto.prototype, "apiKey", void 0);
class OpenaiSaveBodyDto {
}
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Transform)(({ value }) => (typeof value === 'string' && !value.trim() ? undefined : value)),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], OpenaiSaveBodyDto.prototype, "apiKey", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], OpenaiSaveBodyDto.prototype, "skipConnectionTest", void 0);
class ElevenlabsTestBodyDto {
}
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Transform)(({ value }) => (typeof value === 'string' && !value.trim() ? undefined : value)),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], ElevenlabsTestBodyDto.prototype, "apiKey", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Transform)(({ value }) => (typeof value === 'string' && !value.trim() ? undefined : value)),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], ElevenlabsTestBodyDto.prototype, "voiceId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Transform)(({ value }) => (typeof value === 'string' && !value.trim() ? undefined : value)),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], ElevenlabsTestBodyDto.prototype, "model", void 0);
class ElevenlabsSaveBodyDto extends ElevenlabsTestBodyDto {
}
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Transform)(({ value }) => (typeof value === 'string' && !value.trim() ? undefined : value)),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], ElevenlabsSaveBodyDto.prototype, "defaultVoiceId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Transform)(({ value }) => (typeof value === 'string' && !value.trim() ? undefined : value)),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], ElevenlabsSaveBodyDto.prototype, "defaultModel", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], ElevenlabsSaveBodyDto.prototype, "skipConnectionTest", void 0);
let TenantIntegrationsController = class TenantIntegrationsController {
    constructor(svc) {
        this.svc = svc;
    }
    summary(tenantId) {
        return this.svc.getSafeSummary(tenantId);
    }
    testShopify(tenantId, body) {
        return this.svc.testShopify(tenantId, body);
    }
    saveShopify(tenantId, body) {
        return this.svc.saveShopify(tenantId, body);
    }
    testTwilio(tenantId, body) {
        return this.svc.testTwilio(tenantId, body);
    }
    saveTwilio(tenantId, body) {
        return this.svc.saveTwilio(tenantId, body);
    }
    configureTwilioWebhook(tenantId, _body) {
        return this.svc.configureTwilioWebhook(tenantId);
    }
    testOpenai(tenantId, body) {
        return this.svc.testOpenai(tenantId, body);
    }
    testOpenaiSaved(tenantId) {
        return this.svc.testOpenai(tenantId, {});
    }
    saveOpenai(tenantId, body) {
        return this.svc.saveOpenai(tenantId, body);
    }
    testElevenlabs(tenantId, body) {
        return this.svc.testElevenlabs(tenantId, body);
    }
    saveElevenlabs(tenantId, body) {
        return this.svc.saveElevenlabs(tenantId, body);
    }
    testEmail(tenantId, body) {
        return this.svc.testEmail(tenantId, body);
    }
    saveEmail(tenantId, body) {
        return this.svc.saveEmail(tenantId, body);
    }
};
exports.TenantIntegrationsController = TenantIntegrationsController;
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 60, ttl: 60_000 } }),
    (0, common_1.Get)(),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], TenantIntegrationsController.prototype, "summary", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 10, ttl: 60_000 } }),
    (0, common_1.Post)('shopify/test'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, ShopifyTestBodyDto]),
    __metadata("design:returntype", void 0)
], TenantIntegrationsController.prototype, "testShopify", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 10, ttl: 60_000 } }),
    (0, common_1.Put)('shopify'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, ShopifySaveBodyDto]),
    __metadata("design:returntype", void 0)
], TenantIntegrationsController.prototype, "saveShopify", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 10, ttl: 60_000 } }),
    (0, common_1.Post)('twilio/test'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(tenant_integrations_validation_1.twilioTestBodySchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, void 0]),
    __metadata("design:returntype", void 0)
], TenantIntegrationsController.prototype, "testTwilio", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 10, ttl: 60_000 } }),
    (0, common_1.Put)('twilio'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(tenant_integrations_validation_1.twilioSaveBodySchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, void 0]),
    __metadata("design:returntype", void 0)
], TenantIntegrationsController.prototype, "saveTwilio", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 10, ttl: 60_000 } }),
    (0, common_1.Post)('twilio/configure-webhook'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(tenant_integrations_validation_1.twilioConfigureWebhookBodySchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, void 0]),
    __metadata("design:returntype", void 0)
], TenantIntegrationsController.prototype, "configureTwilioWebhook", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 10, ttl: 60_000 } }),
    (0, common_1.Post)('openai/test'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, OpenaiTestBodyDto]),
    __metadata("design:returntype", void 0)
], TenantIntegrationsController.prototype, "testOpenai", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 10, ttl: 60_000 } }),
    (0, common_1.Post)('openai/test-saved'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], TenantIntegrationsController.prototype, "testOpenaiSaved", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 10, ttl: 60_000 } }),
    (0, common_1.Put)('openai'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, OpenaiSaveBodyDto]),
    __metadata("design:returntype", void 0)
], TenantIntegrationsController.prototype, "saveOpenai", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 10, ttl: 60_000 } }),
    (0, common_1.Post)('elevenlabs/test'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, ElevenlabsTestBodyDto]),
    __metadata("design:returntype", void 0)
], TenantIntegrationsController.prototype, "testElevenlabs", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 10, ttl: 60_000 } }),
    (0, common_1.Put)('elevenlabs'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, ElevenlabsSaveBodyDto]),
    __metadata("design:returntype", void 0)
], TenantIntegrationsController.prototype, "saveElevenlabs", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 10, ttl: 60_000 } }),
    (0, common_1.Post)('email/test'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(tenant_integrations_validation_1.emailTestBodySchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, void 0]),
    __metadata("design:returntype", void 0)
], TenantIntegrationsController.prototype, "testEmail", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 10, ttl: 60_000 } }),
    (0, common_1.Put)('email'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(tenant_integrations_validation_1.emailSaveBodySchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, void 0]),
    __metadata("design:returntype", void 0)
], TenantIntegrationsController.prototype, "saveEmail", null);
exports.TenantIntegrationsController = TenantIntegrationsController = __decorate([
    (0, common_1.Controller)('tenant-integrations'),
    (0, roles_decorator_1.Roles)(client_1.UserRole.MANAGER),
    __metadata("design:paramtypes", [tenant_integrations_service_1.TenantIntegrationsService])
], TenantIntegrationsController);
//# sourceMappingURL=tenant-integrations.controller.js.map