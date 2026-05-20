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
exports.ElevenLabsController = void 0;
const common_1 = require("@nestjs/common");
const throttler_1 = require("@nestjs/throttler");
const client_1 = require("@prisma/client");
const elevenlabs_service_1 = require("./elevenlabs.service");
const tenant_id_decorator_1 = require("../../../common/decorators/tenant-id.decorator");
const roles_decorator_1 = require("../../../common/decorators/roles.decorator");
const zod_validation_pipe_1 = require("../../../common/pipes/zod-validation.pipe");
const elevenlabs_validation_1 = require("./elevenlabs-validation");
let ElevenLabsController = class ElevenLabsController {
    constructor(elevenLabs) {
        this.elevenLabs = elevenLabs;
    }
    async test(_tenantId, body) {
        await this.elevenLabs.textToSpeech(body.text ?? 'Hello, this is a voice agent test.', body.voiceId);
        return { ok: true, message: 'ElevenLabs returned audio successfully.' };
    }
};
exports.ElevenLabsController = ElevenLabsController;
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 20, ttl: 60_000 } }),
    (0, common_1.Post)('test'),
    __param(0, (0, tenant_id_decorator_1.TenantId)()),
    __param(1, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(elevenlabs_validation_1.elevenLabsTestBodySchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, void 0]),
    __metadata("design:returntype", Promise)
], ElevenLabsController.prototype, "test", null);
exports.ElevenLabsController = ElevenLabsController = __decorate([
    (0, common_1.Controller)('integrations/elevenlabs'),
    (0, roles_decorator_1.Roles)(client_1.UserRole.MANAGER),
    __metadata("design:paramtypes", [elevenlabs_service_1.ElevenLabsService])
], ElevenLabsController);
//# sourceMappingURL=elevenlabs.controller.js.map