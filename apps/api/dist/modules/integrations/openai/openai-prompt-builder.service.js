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
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAIPromptBuilderService = void 0;
const common_1 = require("@nestjs/common");
const build_agent_runtime_prompt_1 = require("../../calls/runtime/build-agent-runtime-prompt");
const runtime_tool_registry_service_1 = require("../../tools/runtime-tool-registry.service");
let OpenAIPromptBuilderService = class OpenAIPromptBuilderService {
    constructor(toolRegistry) {
        this.toolRegistry = toolRegistry;
    }
    build(ctx) {
        const step = ctx.metadata && typeof ctx.metadata === 'object' && !Array.isArray(ctx.metadata)
            ? ctx.metadata.orderState
            : null;
        const checkoutStep = typeof step === 'string' && step.trim() ? step.trim() : null;
        const personality = (ctx.agent.personality ?? null);
        const enabledTools = this.toolRegistry.resolveEnabledToolNames({
            enabledTools: ctx.agent.enabledTools,
            toolPermissions: ctx.agent.toolPermissions,
        });
        return (0, build_agent_runtime_prompt_1.buildAgentRuntimePrompt)((0, build_agent_runtime_prompt_1.promptInputFromVoiceSessionContext)(ctx), {
            checkoutStep,
            personality,
            enabledTools,
        });
    }
};
exports.OpenAIPromptBuilderService = OpenAIPromptBuilderService;
exports.OpenAIPromptBuilderService = OpenAIPromptBuilderService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [runtime_tool_registry_service_1.RuntimeToolRegistryService])
], OpenAIPromptBuilderService);
//# sourceMappingURL=openai-prompt-builder.service.js.map