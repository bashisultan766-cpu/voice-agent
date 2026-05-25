"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CallsModule = void 0;
const common_1 = require("@nestjs/common");
const calls_controller_1 = require("./calls.controller");
const calls_service_1 = require("./calls.service");
const voice_runtime_controller_1 = require("./runtime/voice-runtime.controller");
const voice_config_check_controller_1 = require("./runtime/voice-config-check.controller");
const voice_config_check_service_1 = require("./runtime/voice-config-check.service");
const voice_runtime_service_1 = require("./runtime/voice-runtime.service");
const session_context_service_1 = require("./runtime/session-context.service");
const transcript_buffer_service_1 = require("./runtime/transcript-buffer.service");
const tool_orchestrator_service_1 = require("./runtime/tool-orchestrator.service");
const voice_runtime_context_service_1 = require("./runtime/voice-runtime-context.service");
const runtime_safety_service_1 = require("./runtime/runtime-safety.service");
const call_memory_service_1 = require("./runtime/call-memory.service");
const openai_module_1 = require("../integrations/openai/openai.module");
const openai_voice_service_1 = require("../integrations/openai/openai-voice.service");
const knowledge_module_1 = require("../knowledge/knowledge.module");
const analytics_module_1 = require("../analytics/analytics.module");
const agents_module_1 = require("../agents/agents.module");
const callback_requests_service_1 = require("./callback-requests.service");
const callback_requests_controller_1 = require("./callback-requests.controller");
const twilio_module_1 = require("../integrations/twilio/twilio.module");
const shopify_module_1 = require("../integrations/shopify/shopify.module");
const email_module_1 = require("../integrations/email/email.module");
const tools_module_1 = require("../tools/tools.module");
let CallsModule = class CallsModule {
};
exports.CallsModule = CallsModule;
exports.CallsModule = CallsModule = __decorate([
    (0, common_1.Module)({
        imports: [
            tools_module_1.ToolsModule,
            openai_module_1.OpenAIModule,
            knowledge_module_1.KnowledgeModule,
            analytics_module_1.AnalyticsModule,
            agents_module_1.AgentsModule,
            shopify_module_1.ShopifyModule,
            email_module_1.EmailModule,
            (0, common_1.forwardRef)(() => twilio_module_1.TwilioModule),
        ],
        controllers: [calls_controller_1.CallsController, voice_runtime_controller_1.VoiceRuntimeController, voice_config_check_controller_1.VoiceConfigCheckController, callback_requests_controller_1.CallbackRequestsController],
        providers: [
            calls_service_1.CallsService,
            voice_runtime_service_1.VoiceRuntimeService,
            voice_config_check_service_1.VoiceConfigCheckService,
            session_context_service_1.SessionContextService,
            transcript_buffer_service_1.TranscriptBufferService,
            tool_orchestrator_service_1.ToolOrchestratorService,
            voice_runtime_context_service_1.VoiceRuntimeContextService,
            runtime_safety_service_1.RuntimeSafetyService,
            call_memory_service_1.CallMemoryService,
            openai_voice_service_1.OpenAIVoiceService,
            callback_requests_service_1.CallbackRequestsService,
        ],
        exports: [
            calls_service_1.CallsService,
            session_context_service_1.SessionContextService,
            voice_runtime_service_1.VoiceRuntimeService,
            callback_requests_service_1.CallbackRequestsService,
            transcript_buffer_service_1.TranscriptBufferService,
            tool_orchestrator_service_1.ToolOrchestratorService,
        ],
    })
], CallsModule);
//# sourceMappingURL=calls.module.js.map