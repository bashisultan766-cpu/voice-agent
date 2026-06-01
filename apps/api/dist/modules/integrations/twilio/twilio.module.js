"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TwilioModule = void 0;
const common_1 = require("@nestjs/common");
const prisma_module_1 = require("../../../database/prisma.module");
const twilio_controller_1 = require("./twilio.controller");
const twilio_signature_service_1 = require("./twilio-signature.service");
const twilio_auth_token_resolver_service_1 = require("./twilio-auth-token-resolver.service");
const twilio_webhook_service_1 = require("./twilio-webhook.service");
const twilio_status_callback_service_1 = require("./twilio-status-callback.service");
const agent_resolution_service_1 = require("./agent-resolution.service");
const calls_module_1 = require("../../calls/calls.module");
const analytics_module_1 = require("../../analytics/analytics.module");
const elevenlabs_module_1 = require("../elevenlabs/elevenlabs.module");
const agents_module_1 = require("../../agents/agents.module");
const twilio_tts_cache_service_1 = require("./twilio-tts-cache.service");
const voice_prompt_audio_service_1 = require("./voice-prompt-audio.service");
const voice_audio_cache_service_1 = require("./voice-audio-cache.service");
const twilio_media_stream_service_1 = require("./twilio-media-stream.service");
const twilio_messaging_module_1 = require("./twilio-messaging.module");
let TwilioModule = class TwilioModule {
};
exports.TwilioModule = TwilioModule;
exports.TwilioModule = TwilioModule = __decorate([
    (0, common_1.Module)({
        imports: [
            prisma_module_1.PrismaModule,
            twilio_messaging_module_1.TwilioMessagingModule,
            (0, common_1.forwardRef)(() => calls_module_1.CallsModule),
            analytics_module_1.AnalyticsModule,
            (0, common_1.forwardRef)(() => elevenlabs_module_1.ElevenLabsModule),
            agents_module_1.AgentsModule,
        ],
        controllers: [twilio_controller_1.TwilioVoiceController],
        providers: [
            twilio_auth_token_resolver_service_1.TwilioAuthTokenResolverService,
            twilio_signature_service_1.TwilioSignatureService,
            twilio_webhook_service_1.TwilioWebhookService,
            twilio_status_callback_service_1.TwilioStatusCallbackService,
            agent_resolution_service_1.AgentResolutionService,
            twilio_tts_cache_service_1.TwilioTtsCacheService,
            voice_audio_cache_service_1.VoiceAudioCacheService,
            voice_prompt_audio_service_1.VoicePromptAudioService,
            twilio_media_stream_service_1.TwilioMediaStreamService,
        ],
        exports: [agent_resolution_service_1.AgentResolutionService, twilio_messaging_module_1.TwilioMessagingModule],
    })
], TwilioModule);
//# sourceMappingURL=twilio.module.js.map