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
    build(ctx, extras) {
        const meta = ctx.metadata && typeof ctx.metadata === 'object' && !Array.isArray(ctx.metadata)
            ? ctx.metadata
            : {};
        const step = meta.orderState;
        const checkoutStep = typeof step === 'string' && step.trim() ? step.trim() : null;
        const mem = meta.conversationMemory;
        const memorySummary = extras?.memorySummary ??
            (mem && typeof mem === 'object' ? this.summarizeMemory(mem) : null);
        const conversationStage = extras?.conversationStage ??
            (typeof mem?.conversationStage === 'string'
                ? String(mem.conversationStage)
                : null);
        const stageGuidance = extras?.stageGuidance ??
            (typeof meta.conversationStageGuidance === 'string' ? meta.conversationStageGuidance : null);
        const personality = (ctx.agent.personality ?? null);
        const enabledTools = this.toolRegistry.resolveEnabledToolNames({
            enabledTools: ctx.agent.enabledTools,
            toolPermissions: ctx.agent.toolPermissions,
        });
        const policyTopic = typeof meta.policyTopic === 'string' ? meta.policyTopic : null;
        const knowledgeRetrievalSnapshot = typeof meta.policyRetrievalSnapshot === 'string' ? meta.policyRetrievalSnapshot : null;
        const policyRetrievalRequired = meta.policyRetrievalRequired === true;
        const salesGuidance = typeof meta.salesGuidance === 'string' ? meta.salesGuidance : null;
        return (0, build_agent_runtime_prompt_1.buildAgentRuntimePrompt)((0, build_agent_runtime_prompt_1.promptInputFromVoiceSessionContext)(ctx), {
            checkoutStep,
            conversationStage,
            stageGuidance,
            memorySummary,
            personality,
            enabledTools,
            policyTopic,
            knowledgeRetrievalSnapshot,
            policyRetrievalRequired,
            salesGuidance,
        });
    }
    summarizeMemory(mem) {
        const parts = [];
        if (typeof mem.customerName === 'string' && mem.customerName.trim()) {
            parts.push(`Customer: ${mem.customerName.trim()}`);
        }
        const genres = mem.preferredGenres;
        if (Array.isArray(genres) && genres.length) {
            parts.push(`Genres: ${genres.join(', ')}`);
        }
        const discussed = (mem.discussedProducts ?? mem.mentionedProducts);
        if (Array.isArray(discussed) && discussed.length) {
            const titles = discussed
                .map((p) => (p && typeof p === 'object' && 'title' in p ? String(p.title) : ''))
                .filter(Boolean)
                .slice(-4);
            if (titles.length)
                parts.push(`Discussed product titles (verify via Shopify if quoting): ${titles.join('; ')}`);
        }
        return parts.length ? parts.join('. ') : null;
    }
};
exports.OpenAIPromptBuilderService = OpenAIPromptBuilderService;
exports.OpenAIPromptBuilderService = OpenAIPromptBuilderService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [runtime_tool_registry_service_1.RuntimeToolRegistryService])
], OpenAIPromptBuilderService);
//# sourceMappingURL=openai-prompt-builder.service.js.map