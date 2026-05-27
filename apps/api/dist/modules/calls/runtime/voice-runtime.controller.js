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
exports.VoiceRuntimeController = void 0;
const common_1 = require("@nestjs/common");
const throttler_1 = require("@nestjs/throttler");
const client_1 = require("@prisma/client");
const voice_runtime_service_1 = require("./voice-runtime.service");
const voice_live_monitor_service_1 = require("./voice-live-monitor.service");
const roles_decorator_1 = require("../../../common/decorators/roles.decorator");
const zod_validation_pipe_1 = require("../../../common/pipes/zod-validation.pipe");
const voice_runtime_schema_1 = require("./voice-runtime.schema");
const ops_validation_1 = require("../../ops/ops-validation");
let VoiceRuntimeController = class VoiceRuntimeController {
    constructor(runtime, liveMonitor) {
        this.runtime = runtime;
        this.liveMonitor = liveMonitor;
    }
    async getGreeting(query) {
        const text = await this.runtime.getGreeting(query.callSessionId);
        return { greeting: text };
    }
    async getContext(callSessionId) {
        const greeting = await this.runtime.getGreeting(callSessionId);
        const systemPrompt = await this.runtime.buildSystemPrompt(callSessionId);
        return { greeting, systemPrompt };
    }
    async getLiveMonitor(query) {
        const snap = await this.liveMonitor.snapshot(query.callSessionId);
        if (!snap)
            return { ok: false, message: 'Call session not found' };
        return { ok: true, ...snap };
    }
    async processTurn(body) {
        const { callSessionId, message, history = [] } = body;
        const { reply } = await this.runtime.processUtterance(callSessionId, message, history);
        return { reply };
    }
};
exports.VoiceRuntimeController = VoiceRuntimeController;
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 60, ttl: 60_000 } }),
    (0, common_1.Get)('greeting'),
    __param(0, (0, common_1.Query)(new zod_validation_pipe_1.ZodValidationPipe(voice_runtime_schema_1.greetingQuerySchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [void 0]),
    __metadata("design:returntype", Promise)
], VoiceRuntimeController.prototype, "getGreeting", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 60, ttl: 60_000 } }),
    (0, common_1.Get)('session/:callSessionId/context'),
    __param(0, (0, common_1.Param)('callSessionId', new zod_validation_pipe_1.ZodValidationPipe(ops_validation_1.cuidParamSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], VoiceRuntimeController.prototype, "getContext", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: 120, ttl: 60_000 } }),
    (0, common_1.Get)('live-monitor'),
    __param(0, (0, common_1.Query)(new zod_validation_pipe_1.ZodValidationPipe(voice_runtime_schema_1.greetingQuerySchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [void 0]),
    __metadata("design:returntype", Promise)
], VoiceRuntimeController.prototype, "getLiveMonitor", null);
__decorate([
    (0, throttler_1.Throttle)({ default: { limit: Number(process.env.API_RATE_LIMIT_SENSITIVE_MAX) || 40, ttl: 60_000 } }),
    (0, common_1.Post)('turn'),
    __param(0, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(voice_runtime_schema_1.turnBodySchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [void 0]),
    __metadata("design:returntype", Promise)
], VoiceRuntimeController.prototype, "processTurn", null);
exports.VoiceRuntimeController = VoiceRuntimeController = __decorate([
    (0, common_1.Controller)('calls/runtime'),
    (0, roles_decorator_1.Roles)(client_1.UserRole.MANAGER),
    __metadata("design:paramtypes", [voice_runtime_service_1.VoiceRuntimeService,
        voice_live_monitor_service_1.VoiceLiveMonitorService])
], VoiceRuntimeController);
//# sourceMappingURL=voice-runtime.controller.js.map