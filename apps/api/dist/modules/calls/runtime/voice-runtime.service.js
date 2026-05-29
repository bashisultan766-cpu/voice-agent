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
var VoiceRuntimeService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.VoiceRuntimeService = void 0;
const common_1 = require("@nestjs/common");
const session_context_service_1 = require("./session-context.service");
const calls_service_1 = require("../calls.service");
const openai_prompt_builder_service_1 = require("../../integrations/openai/openai-prompt-builder.service");
const llm_agent_orchestrator_service_1 = require("./llm-agent-orchestrator.service");
const transcript_normalizer_service_1 = require("./transcript-normalizer.service");
const voice_single_reply_pipeline_util_1 = require("./voice-single-reply-pipeline.util");
const call_events_service_1 = require("../../analytics/call-events.service");
const call_outcome_service_1 = require("../../analytics/call-outcome.service");
const client_1 = require("@prisma/client");
const transcript_buffer_service_1 = require("./transcript-buffer.service");
const redact_voice_input_1 = require("../../../common/redact-voice-input");
const tool_orchestrator_service_1 = require("./tool-orchestrator.service");
const runtime_safety_service_1 = require("./runtime-safety.service");
const conversation_flow_engine_service_1 = require("./conversation-flow-engine.service");
const conversation_analytics_service_1 = require("./conversation-analytics.service");
const call_memory_service_1 = require("./call-memory.service");
const voice_speaking_util_1 = require("./voice-speaking.util");
const professional_conversation_policy_util_1 = require("./professional-conversation-policy.util");
const policy_context_prefetch_service_1 = require("./policy-context-prefetch.service");
const professional_voice_response_util_1 = require("./professional-voice-response.util");
const response_mode_util_1 = require("./response-mode.util");
const context_aware_reply_util_1 = require("./context-aware-reply.util");
let VoiceRuntimeService = VoiceRuntimeService_1 = class VoiceRuntimeService {
    constructor(sessionContext, callsService, llmAgent, transcriptNormalizer, tools, callEvents, callOutcome, transcriptBuffer, promptBuilder, runtimeSafety, conversationFlow, conversationAnalytics, callMemory, policyPrefetch) {
        this.sessionContext = sessionContext;
        this.callsService = callsService;
        this.llmAgent = llmAgent;
        this.transcriptNormalizer = transcriptNormalizer;
        this.tools = tools;
        this.callEvents = callEvents;
        this.callOutcome = callOutcome;
        this.transcriptBuffer = transcriptBuffer;
        this.promptBuilder = promptBuilder;
        this.runtimeSafety = runtimeSafety;
        this.conversationFlow = conversationFlow;
        this.conversationAnalytics = conversationAnalytics;
        this.callMemory = callMemory;
        this.policyPrefetch = policyPrefetch;
        this.logger = new common_1.Logger(VoiceRuntimeService_1.name);
    }
    deterministicFallbackEnabled() {
        return true;
    }
    resolveInterruptIntent(userIntent, text) {
        if (userIntent === 'product_search' || userIntent === 'product_question') {
            return { intent: 'product_search', confidence: 0.9 };
        }
        if (userIntent === 'payment_question') {
            return { intent: 'pricing_question', confidence: 0.82 };
        }
        if (userIntent === 'store_policy_question') {
            return { intent: 'support_question', confidence: 0.8 };
        }
        const t = text.toLowerCase();
        if (/\b(order status|where is my order|track my order|tracking number|order number)\b/.test(t)) {
            return { intent: 'order_lookup', confidence: 0.85 };
        }
        return { intent: undefined, confidence: 0.2 };
    }
    professionalReplyFromSearchTool(search, tone, followUpOfferedProductKey) {
        if (!search.ok) {
            return {
                text: "I couldn't search the store catalog right now. Please try again in a moment.",
                templateKey: 'catalog_unavailable',
                toneLeadUsed: null,
                paymentSuggestionUsed: false,
                followUpTriggered: false,
                followUpOfferedProductKey: null,
            };
        }
        const data = search.data && typeof search.data === 'object' && !Array.isArray(search.data)
            ? search.data
            : {};
        const results = Array.isArray(data.results) ? data.results : [];
        const requiresClarification = data.requiresClarification === true;
        const top = results[0];
        const title = typeof top?.title === 'string' ? top.title : '';
        const variants = Array.isArray(top?.variants) ? top.variants : [];
        const v0 = variants[0];
        const price = typeof v0?.price === 'string' ? v0.price : null;
        const found = results.length > 0 && !requiresClarification;
        const r = (0, professional_voice_response_util_1.buildProfessionalResponse)({
            state: 'PRODUCT_DISCOVERY',
            product: title ? { title, price } : null,
            email: null,
            found,
            includePaymentSuggestion: false,
            tone,
            followUpOfferedProductKey: followUpOfferedProductKey ?? null,
        });
        return {
            text: r.text,
            templateKey: r.templateKey,
            toneLeadUsed: r.toneLeadUsed ?? null,
            paymentSuggestionUsed: r.paymentSuggestionUsed ?? false,
            followUpTriggered: r.followUpTriggered ?? false,
            followUpOfferedProductKey: r.followUpOfferedProductKey ?? null,
        };
    }
    appendConversationalMomentum(message, userIntent, orderState) {
        const t = message.trim();
        if (!t)
            return t;
        void userIntent;
        void orderState;
        return (0, voice_speaking_util_1.polishVoiceReply)(t, { maxSentences: 3 });
    }
    buildFastVoiceReply(args) {
        const discussed = args.turnPlan.memory.discussedProducts ?? args.turnPlan.memory.mentionedProducts ?? [];
        const lastTitle = discussed.length > 0 ? discussed[discussed.length - 1]?.title ?? null : null;
        const route = (0, professional_conversation_policy_util_1.classifyConversationRouteIntent)({
            customerText: args.customerText,
            userIntent: args.userIntent,
            orderState: args.orderState,
            storeName: args.ctx.store?.name ?? 'SureShot Books',
            agentName: 'Justin',
            selectedProductTitle: lastTitle,
            hasDiscussedProduct: discussed.length > 0,
        });
        if (!(0, professional_conversation_policy_util_1.shouldUseProfessionalFastReply)(route, args.toolCallAllowed)) {
            return null;
        }
        const reply = (0, professional_conversation_policy_util_1.buildProfessionalConversationReply)(route, {
            customerText: args.customerText,
            userIntent: args.userIntent,
            orderState: args.orderState,
            storeName: args.ctx.store?.name ?? 'SureShot Books',
            agentName: 'Justin',
            selectedProductTitle: lastTitle,
            hasDiscussedProduct: discussed.length > 0,
        });
        if (!reply?.trim())
            return null;
        return (0, professional_conversation_policy_util_1.sanitizeBannedVoicePhrases)(reply);
    }
    normalizeForRepeatCheck(text) {
        return text.trim().replace(/\s+/g, ' ').toLowerCase();
    }
    hasSpecificProductSignalForSearch(text) {
        const t = text.trim().toLowerCase();
        if (!t)
            return false;
        if (/\b(i need a book|need a book|want a book|any book|some book|book please|find me a book)\b/i.test(t)) {
            return false;
        }
        if (/\b(?:97[89][-\s]?)?\d{9}[\dx]\b/i.test(t))
            return true;
        if (/\bsku[:\s-]*[a-z0-9_-]{3,}\b/i.test(t))
            return true;
        if (/\b(do you have|check|find|search)\b\s+.{2,}/i.test(t))
            return true;
        if (t.split(/\s+/).length >= 2 && !/\b(sports|electronics|clothes|products|store)\b/i.test(t)) {
            return true;
        }
        return false;
    }
    evaluateSearchToolPolicy(intent, customerText) {
        const customerQuestionType = intent;
        if (intent === 'store_category_question') {
            return {
                toolCallAllowed: false,
                toolCallBlockedReason: 'general_category_question',
                customerQuestionType,
            };
        }
        if (intent === 'store_policy_question') {
            return {
                toolCallAllowed: true,
                toolCallBlockedReason: null,
                customerQuestionType,
            };
        }
        if (intent === 'greeting' ||
            intent === 'small_talk' ||
            intent === 'store_identity_question' ||
            intent === 'capability_question' ||
            intent === 'general_business_question' ||
            intent === 'unclear' ||
            intent === 'unknown') {
            return {
                toolCallAllowed: false,
                toolCallBlockedReason: `intent_${intent}_blocked`,
                customerQuestionType,
            };
        }
        if (intent === 'product_search' && !this.hasSpecificProductSignalForSearch(customerText)) {
            return {
                toolCallAllowed: false,
                toolCallBlockedReason: 'query_not_specific_enough',
                customerQuestionType,
            };
        }
        return { toolCallAllowed: true, toolCallBlockedReason: null, customerQuestionType };
    }
    applyRepeatGuard(args) {
        const previousTemplate = args.previousTemplate?.trim() || null;
        const previousText = args.previousText?.trim() || null;
        const template = args.responseTemplateUsed?.trim() || null;
        const isTemplate = args.responseSource === 'template';
        const duplicateTemplate = Boolean(isTemplate && template && template === previousTemplate);
        const duplicateText = Boolean(isTemplate && previousText) &&
            this.normalizeForRepeatCheck(args.currentReply) === this.normalizeForRepeatCheck(previousText ?? '');
        const shouldSuppress = duplicateTemplate || duplicateText;
        if (!shouldSuppress) {
            return {
                reply: args.currentReply,
                responseMode: args.responseMode,
                responseSource: args.responseSource,
                responseTemplateUsed: args.responseTemplateUsed,
                templateSuppressedBecauseRepeated: false,
                templateUsed: template,
                openaiUsed: args.responseSource === 'openai',
            };
        }
        const fallback = args.openaiFallbackReply?.trim();
        const rephrased = fallback || this.buildNonRepeatingVariant(args.currentReply, args.repeatIndex ?? 0);
        return {
            reply: rephrased,
            responseMode: 'openai',
            responseSource: 'openai',
            responseTemplateUsed: undefined,
            templateSuppressedBecauseRepeated: true,
            templateUsed: null,
            openaiUsed: true,
        };
    }
    buildNonRepeatingVariant(reply, repeatIndex) {
        const base = reply.trim();
        if (!base)
            return 'Sure. Tell me a little more so I can help properly.';
        const leads = ['Sure.', 'Of course.', 'Absolutely.', 'Got it.', 'No problem.'];
        const lead = leads[Math.abs(repeatIndex) % leads.length];
        const stripped = base.replace(/^(understood|sure|okay|got it)[,.!\s-]*/i, '').trim();
        if (!stripped)
            return `${lead} ${base}`;
        return `${lead} ${stripped}`;
    }
    buildConciseIdentityOrCapabilityReply(intent, customerText, orderState = 'IDLE') {
        const route = (0, professional_conversation_policy_util_1.classifyConversationRouteIntent)({
            customerText,
            userIntent: intent,
            orderState,
            storeName: 'SureShot Books',
            agentName: 'Justin',
        });
        if (route !== 'GREETING' &&
            route !== 'SMALL_TALK' &&
            route !== 'WHO_ARE_YOU' &&
            route !== 'HEAR_ME' &&
            route !== 'UNKNOWN_BUSINESS_RELATED') {
            return null;
        }
        const reply = (0, professional_conversation_policy_util_1.buildProfessionalConversationReply)(route, {
            customerText,
            userIntent: intent,
            orderState,
            storeName: 'SureShot Books',
            agentName: 'Justin',
        });
        return reply ? (0, professional_conversation_policy_util_1.sanitizeBannedVoicePhrases)(reply) : null;
    }
    logResponsePath(args) {
        this.logger.log(JSON.stringify({
            event: 'voice.response.path',
            ...args,
        }));
    }
    resolveSpokenReplyAfterOpenAI(args) {
        const conciseIdentityOrCapability = this.buildConciseIdentityOrCapabilityReply(args.userIntent, args.customerText, args.orderStateAfter);
        if (conciseIdentityOrCapability) {
            return {
                reply: conciseIdentityOrCapability,
                responseMode: 'template',
                responseSource: 'template',
                responseTemplateUsed: 'identity_capability_concise_guardrail',
                contextAware: true,
                questionAnsweredFirst: true,
                interruptionHandled: false,
                conversationTone: args.conversationTone,
                toneLeadUsed: null,
                paymentSuggestionUsed: false,
                followUpTriggered: false,
                followUpOfferedProductKey: null,
            };
        }
        const contextAwareReply = (0, context_aware_reply_util_1.buildContextAwareReply)({
            intent: args.userIntent,
            state: args.orderStateAfter,
            previousState: args.orderStateBefore,
            lastUserMessage: args.customerText,
            toolResult: args.toolTrace,
            conversationHistory: args.conversationHistory,
            conversationTone: args.conversationTone,
            lastToneLeadUsed: args.lastToneLeadUsed,
            allowPaymentSuggestion: args.allowPaymentSuggestion,
            followUpOfferedProductKey: args.followUpOfferedProductKey,
        });
        if (contextAwareReply) {
            return {
                reply: contextAwareReply.text,
                responseMode: contextAwareReply.source === 'template' ? 'template' : 'openai',
                responseSource: contextAwareReply.source,
                responseTemplateUsed: contextAwareReply.templateKey,
                contextAware: true,
                questionAnsweredFirst: contextAwareReply.questionAnsweredFirst,
                interruptionHandled: contextAwareReply.interruptionHandled,
                conversationTone: args.conversationTone,
                toneLeadUsed: contextAwareReply.toneLeadUsed,
                paymentSuggestionUsed: contextAwareReply.paymentSuggestionUsed,
                followUpTriggered: contextAwareReply.followUpTriggered ?? false,
                followUpOfferedProductKey: contextAwareReply.followUpOfferedProductKey ?? null,
            };
        }
        const mode = (0, response_mode_util_1.decideResponseMode)({
            intent: args.userIntent,
            state: args.orderStateAfter,
            toolResult: args.toolTrace,
            customerText: args.customerText,
        });
        if (mode === 'openai') {
            return {
                reply: this.appendConversationalMomentum(args.openaiMessage, args.userIntent, args.orderStateAfter),
                responseMode: 'openai',
                responseSource: 'openai',
                contextAware: false,
                questionAnsweredFirst: false,
                interruptionHandled: false,
                conversationTone: args.conversationTone,
                toneLeadUsed: null,
                paymentSuggestionUsed: false,
                followUpTriggered: false,
                followUpOfferedProductKey: null,
            };
        }
        const r = this.buildTemplateReply({
            trace: args.toolTrace,
            orderStateAfter: args.orderStateAfter,
            orderStateBefore: args.orderStateBefore,
            clsIntent: args.clsIntent,
            tone: {
                conversationTone: args.conversationTone,
                lastToneLeadUsed: args.lastToneLeadUsed,
            },
            allowPaymentSuggestion: args.allowPaymentSuggestion,
            followUpOfferedProductKey: args.followUpOfferedProductKey,
        });
        if (r) {
            return {
                reply: r.text,
                responseMode: 'template',
                responseSource: 'template',
                responseTemplateUsed: r.templateKey,
                contextAware: false,
                questionAnsweredFirst: false,
                interruptionHandled: false,
                conversationTone: args.conversationTone,
                toneLeadUsed: r.toneLeadUsed,
                paymentSuggestionUsed: r.paymentSuggestionUsed,
                followUpTriggered: r.followUpTriggered ?? false,
                followUpOfferedProductKey: r.followUpOfferedProductKey ?? null,
            };
        }
        return {
            reply: this.appendConversationalMomentum(args.openaiMessage, args.userIntent, args.orderStateAfter),
            responseMode: 'openai',
            responseSource: 'openai',
            contextAware: false,
            questionAnsweredFirst: false,
            interruptionHandled: false,
            conversationTone: args.conversationTone,
            toneLeadUsed: null,
            paymentSuggestionUsed: false,
            followUpTriggered: false,
            followUpOfferedProductKey: null,
        };
    }
    buildTemplateReply(args) {
        const trace = args.trace;
        const tone = args.tone;
        const allowPay = args.allowPaymentSuggestion === true;
        const followUpKey = args.followUpOfferedProductKey ?? null;
        if (trace?.sendPaymentEmail?.ok) {
            const r = (0, professional_voice_response_util_1.buildProfessionalResponse)({
                state: 'DONE',
                found: false,
                email: trace.sendPaymentEmail.email ?? null,
                product: null,
                tone,
            });
            return {
                text: r.text,
                templateKey: r.templateKey,
                toneLeadUsed: r.toneLeadUsed ?? null,
                paymentSuggestionUsed: r.paymentSuggestionUsed ?? false,
                followUpTriggered: false,
                followUpOfferedProductKey: null,
            };
        }
        if (trace?.sendPaymentEmail && trace.sendPaymentEmail.ok === false) {
            return {
                text: "I wasn't able to send that email just now—want to try the same address again in a moment?",
                templateKey: 'payment_email_failed',
                toneLeadUsed: null,
                paymentSuggestionUsed: false,
                followUpTriggered: false,
                followUpOfferedProductKey: null,
            };
        }
        const sp = trace?.searchProducts;
        if (sp &&
            (args.orderStateAfter === 'PRODUCT_SEARCH' ||
                args.orderStateBefore === 'PRODUCT_SEARCH' ||
                args.orderStateAfter === 'PRODUCT_DISCOVERY' ||
                args.orderStateBefore === 'PRODUCT_DISCOVERY')) {
            if (sp.ok && sp.found && !sp.requiresClarification && sp.title) {
                const r = (0, professional_voice_response_util_1.buildProfessionalResponse)({
                    state: 'PRODUCT_SEARCH',
                    product: { title: sp.title, price: sp.price ?? null },
                    email: null,
                    found: true,
                    includePaymentSuggestion: allowPay,
                    tone,
                    followUpOfferedProductKey: followUpKey,
                });
                return {
                    text: r.text,
                    templateKey: r.templateKey,
                    toneLeadUsed: r.toneLeadUsed ?? null,
                    paymentSuggestionUsed: r.paymentSuggestionUsed ?? false,
                    followUpTriggered: r.followUpTriggered ?? false,
                    followUpOfferedProductKey: r.followUpOfferedProductKey ?? null,
                };
            }
            if (sp.ok === false && sp.errorCode === 'SHOPIFY_SEARCH_FAILED') {
                return {
                    text: "I couldn't search the store catalog right now. Please try again in a moment.",
                    templateKey: 'catalog_unavailable',
                    toneLeadUsed: null,
                    paymentSuggestionUsed: false,
                    followUpTriggered: false,
                    followUpOfferedProductKey: null,
                };
            }
        }
        if (trace?.validateEmail?.valid === false &&
            (args.orderStateAfter === 'EMAIL_COLLECTING' ||
                args.orderStateAfter === 'EMAIL_CONFIRMING' ||
                args.orderStateAfter === 'EMAIL_COLLECTION')) {
            return {
                text: 'Hmm, that does not sound like a complete email—could you give it to me one more time?',
                templateKey: 'invalid_email',
                toneLeadUsed: null,
                paymentSuggestionUsed: false,
                followUpTriggered: false,
                followUpOfferedProductKey: null,
            };
        }
        return null;
    }
    isDeliveryQuestion(text) {
        const t = text.toLowerCase();
        return (t.includes('delivery') ||
            t.includes('deliver') ||
            t.includes('shipping') ||
            t.includes('ship') ||
            t.includes('delivery times') ||
            t.includes('when will') ||
            t.includes('tempo di consegna') ||
            t.includes('consegna') ||
            t.includes('spedizione') ||
            t.includes('доставка') ||
            t.includes('достав'));
    }
    async respondDeterministicallyOnOpenAI429(args) {
        const ctx = await this.sessionContext.load(args.callSessionId);
        if (!ctx) {
            return {
                reply: "I'm sorry, I couldn't load your session. Please try again.",
                responseSource: 'template',
                responseTemplateUsed: 'fallback_429_session_missing',
            };
        }
        this.logger.warn(JSON.stringify({
            event: 'voice.journey.deterministic_fallback_used',
            callSessionId: args.callSessionId,
            tenantId: ctx.tenantId,
            agentId: ctx.agentId,
            fallback_used: true,
            reason: 'openai_429',
            intent: args.intent,
        }));
        await this.callEvents.log(ctx.tenantId, args.callSessionId, client_1.CallEventType.FALLBACK_USED, {
            reason: 'openai_429',
            deterministicFallback: true,
            intent: args.intent,
        });
        const preserveState = async () => {
            await this.callsService.mergeSessionMetadata(args.callSessionId, {
                orderState: args.preserveOrderState,
                deterministicFallback: true,
                deterministicFallbackReason: 'openai_429',
            });
        };
        if (args.intent === 'product_search') {
            const search = await this.tools.execute(ctx, 'searchProducts', { query: args.userText, limit: 5 }, args.callSessionId, 'deterministic_fallback_search');
            await preserveState();
            if (!search.ok) {
                const b = this.professionalReplyFromSearchTool(search);
                return { reply: b.text, responseSource: 'template', responseTemplateUsed: b.templateKey };
            }
            const data = search.data && typeof search.data === 'object' && !Array.isArray(search.data)
                ? search.data
                : {};
            const confidence = typeof data.confidence === 'number' ? data.confidence : null;
            const requiresClarification = data.requiresClarification === true;
            if (requiresClarification || (confidence !== null && confidence < 0.45)) {
                const r = (0, professional_voice_response_util_1.buildProfessionalResponse)({
                    state: 'PRODUCT_DISCOVERY',
                    product: null,
                    email: null,
                    found: false,
                });
                return { reply: r.text, responseSource: 'template', responseTemplateUsed: r.templateKey };
            }
            const b = this.professionalReplyFromSearchTool(search);
            return { reply: b.text, responseSource: 'template', responseTemplateUsed: b.templateKey };
        }
        if (args.intent === 'general_question' && this.isDeliveryQuestion(args.userText)) {
            const cfg = ctx.agent.config;
            const deliveryNotes = cfg?.deliveryNotes?.trim() || '';
            const shippingPolicy = cfg?.shippingPolicy?.trim() || '';
            const line = deliveryNotes || shippingPolicy;
            if (line) {
                return {
                    reply: line,
                    responseSource: 'template',
                    responseTemplateUsed: 'delivery_faq_store_config',
                };
            }
            return {
                reply: "I don't have verified delivery timing details available right now. I can take your details for a callback, or you can check the shipping policy on the store website.",
                responseSource: 'template',
                responseTemplateUsed: 'delivery_faq_unavailable',
            };
        }
        if (args.intent === 'order_confirmed' ||
            args.intent === 'email_provided' ||
            args.intent === 'quantity_provided' ||
            args.intent === 'variant_selected') {
            return {
                reply: "I'm temporarily unable to complete checkout steps right now. I can still help you find products and confirm availability, or connect you with the team to finalize payment.",
                responseSource: 'template',
                responseTemplateUsed: 'fallback_429_checkout_blocked',
            };
        }
        return {
            reply: "I'm temporarily unable to complete that step right now. I can still help search products and confirm availability.",
            responseSource: 'template',
            responseTemplateUsed: 'fallback_429_generic',
        };
    }
    async getGreeting(callSessionId) {
        const ctx = await this.sessionContext.load(callSessionId);
        if (!ctx)
            return "Hello, I'm having trouble loading your session. Please try again.";
        const greeting = ctx.agent.greetingMessage?.trim() ??
            'Hello, this is Justin with SureShot Books. How can I help you find or order a book today?';
        return greeting;
    }
    async buildSystemPrompt(callSessionId) {
        const ctx = await this.sessionContext.load(callSessionId);
        if (!ctx)
            return 'You are a helpful voice assistant.';
        return this.promptBuilder.build(ctx);
    }
    async onRuntimeConnected(callSessionId) {
        const existing = await this.callsService.findOneById(callSessionId);
        if (existing.status === client_1.CallStatus.IN_PROGRESS) {
            return;
        }
        const ctx = await this.sessionContext.load(callSessionId);
        await this.callsService.updateSessionStatus(callSessionId, {
            status: client_1.CallStatus.IN_PROGRESS,
            answeredAt: new Date(),
            lastEventAt: new Date(),
        });
        if (ctx) {
            console.log('[voice-runtime] loaded agent', ctx.agentId, ctx.agent.name);
            console.log('[voice-runtime] using prompt version', ctx.configUpdatedAt ?? 'unknown');
            await this.callEvents.log(ctx.tenantId, callSessionId, client_1.CallEventType.TWILIO_CONNECTED);
            await this.callEvents.log(ctx.tenantId, callSessionId, client_1.CallEventType.OPENAI_SESSION_STARTED);
            this.logger.log(JSON.stringify({
                event: 'voice.journey.session_active',
                callSessionId,
                tenantId: ctx.tenantId,
                agentId: ctx.agentId,
                agentName: ctx.agent.name,
                configUpdatedAt: ctx.configUpdatedAt,
            }));
        }
    }
    async onRuntimeDisconnected(callSessionId) {
        const session = await this.callsService.findOneById(callSessionId);
        if (session.endedAt) {
            return;
        }
        const endedAt = new Date();
        const durationSeconds = session.startedAt ? Math.floor((endedAt.getTime() - new Date(session.startedAt).getTime()) / 1000) : undefined;
        await this.callsService.updateSessionStatus(callSessionId, {
            status: client_1.CallStatus.COMPLETED,
            endedAt,
            durationSeconds,
            lastEventAt: endedAt,
        });
        await this.callEvents.log(session.tenantId, callSessionId, client_1.CallEventType.CALL_COMPLETED, {
            durationSeconds,
            escalated: session.escalated,
        });
        const metaEnd = (session.metadata ?? {});
        const memEnd = metaEnd.conversationMemory;
        const stage = typeof memEnd?.conversationStage === 'string'
            ? memEnd.conversationStage
            : typeof metaEnd.conversationStage === 'string'
                ? metaEnd.conversationStage
                : 'unknown';
        if (session.status === client_1.CallStatus.COMPLETED || session.status === client_1.CallStatus.ABANDONED) {
            await this.conversationAnalytics.recordAbandonedStage(session.tenantId, callSessionId, stage);
        }
        await this.callOutcome.deriveAndUpsert(callSessionId);
        this.logger.log(JSON.stringify({
            event: 'voice.journey.session_completed',
            callSessionId,
            tenantId: session.tenantId,
            durationSeconds,
            escalated: session.escalated,
        }));
    }
    async processUtterance(callSessionId, text, conversationHistory = []) {
        const safeText = (0, redact_voice_input_1.redactPaymentLikePatterns)(text);
        const trimmedUserText = safeText.trim();
        let reply = '';
        const safety = this.runtimeSafety.checkUserInput(safeText);
        if (safety.blocked) {
            reply = this.runtimeSafety.refusalReply(safety.category);
            const ctxEarly = await this.sessionContext.load(callSessionId);
            if (ctxEarly) {
                await this.conversationAnalytics.recordRefusal(ctxEarly.tenantId, callSessionId, safety.category);
            }
            return { reply };
        }
        if (safeText !== text) {
            reply =
                'For your security, I cannot collect card details on this call. I can send a secure Shopify checkout link by SMS or email so you can pay safely there.';
            return { reply };
        }
        if (!trimmedUserText) {
            reply = "I didn't catch that. Could you say that again?";
            return { reply };
        }
        const ctx = await this.sessionContext.load(callSessionId);
        if (!ctx) {
            this.logger.error(JSON.stringify({
                event: 'voice.journey.session_missing',
                callSessionId,
            }));
            reply =
                "I'm sorry, this call session could not be loaded. Please hang up and call again, or contact store support.";
            this.logger.error(JSON.stringify({
                event: 'voice.brain.bypass_detected',
                sessionId: callSessionId,
                userText: trimmedUserText.slice(0, 500),
                reason: 'session_missing',
            }));
            return { reply };
        }
        const historyFromDb = conversationHistory.length > 0
            ? conversationHistory
            : await this.transcriptBuffer.getConversationHistory(callSessionId, 24);
        const normalization = await this.transcriptNormalizer.normalizeTranscript(trimmedUserText, {
            tenantId: ctx.tenantId,
            agentId: ctx.agentId,
            callSessionId,
            conversationHistory: historyFromDb,
        });
        const orchestratorSpeech = normalization.normalized;
        await this.callsService.mergeSessionMetadata(callSessionId, {
            lastRawTranscript: normalization.raw,
            lastNormalizedTranscript: normalization.normalized,
            transcriptNormalizeConfidence: normalization.confidence,
            transcriptNormalizeCorrected: normalization.corrected,
        });
        const userSeq = await this.transcriptBuffer.getNextSequence(callSessionId);
        await this.transcriptBuffer.append(callSessionId, 'user', orchestratorSpeech, userSeq);
        this.logger.log(JSON.stringify({
            event: 'voice.brain.selected',
            agentId: ctx.agentId,
            sessionId: callSessionId,
            tenantId: ctx.tenantId,
            userText: orchestratorSpeech.slice(0, 500),
            rawTranscript: normalization.raw.slice(0, 500),
            transcriptCorrected: normalization.corrected,
            brain: 'openai_llm_agent_orchestrator',
        }));
        const llmStartedAt = Date.now();
        const result = await this.llmAgent.handleTurn(callSessionId, orchestratorSpeech, historyFromDb);
        const responseDelayMs = Date.now() - llmStartedAt;
        if (result.toolCallsCount > 0) {
            await this.conversationAnalytics.recordToolLatency(ctx.tenantId, callSessionId, responseDelayMs, 'voice_tool_loop');
        }
        reply = result.reply;
        if (result.error?.code === 'OPENAI_429' || result.error?.code === 'OPENAI_ERROR' || result.error?.code === 'NO_KEY') {
            reply =
                ctx.agent.fallbackMessage ??
                    "I'm having a brief issue reaching our system. What book title or topic can I help you find?";
            await this.callEvents.log(ctx.tenantId, callSessionId, client_1.CallEventType.FALLBACK_USED, {
                reason: result.error?.code ?? 'openai_error',
                brainBypass: true,
            });
        }
        const agentSeq = await this.transcriptBuffer.getNextSequence(callSessionId);
        await this.transcriptBuffer.append(callSessionId, 'agent', reply, agentSeq);
        await this.callsService.mergeSessionMetadata(callSessionId, (0, voice_single_reply_pipeline_util_1.buildLlmReplyMetadataPatch)(reply));
        if (result.escalated) {
            await this.callsService.updateSessionStatus(callSessionId, {
                escalated: true,
                lastEventAt: new Date(),
                metadata: { endedReason: 'escalated' },
            });
            await this.callEvents.log(ctx.tenantId, callSessionId, client_1.CallEventType.ESCALATION_TRIGGERED);
        }
        this.logger.log(JSON.stringify({
            event: 'voice.brain.final_reply',
            agentId: ctx.agentId,
            sessionId: callSessionId,
            replyPreview: reply.slice(0, 240),
            toolCallsUsed: result.toolNames,
            intent: result.state.customerIntent ?? null,
            stateStage: result.state.checkoutStage,
            latencyMs: responseDelayMs,
        }));
        const turnProof = {
            callSessionId,
            tenantId: ctx.tenantId,
            agentId: ctx.agentId,
            userSpeechText: safeText.slice(0, 500),
            openaiKeySource: result.proof?.openaiKeySource ?? 'none',
            modelUsed: result.proof?.modelUsed ?? 'unknown',
            openaiCalled: result.proof?.openaiCalled ?? true,
            openaiSuccess: result.proof?.openaiSuccess ?? !result.error,
            replyPreview: reply.slice(0, 240),
            voiceProvider: ctx.agent.voiceProvider ?? null,
            voiceIdPresent: Boolean(ctx.agent.voiceId?.trim()),
            ttsProviderUsed: null,
            flowStep: result.toolCallsCount > 0 ? 'llm_agent_tool_loop' : 'llm_agent_reply',
            brain: 'openai_llm_agent_orchestrator',
            llmTools: result.toolNames,
            openaiUsed: true,
        };
        this.logTurnProof(turnProof);
        return { reply, turnProof };
    }
    logTurnProof(p) {
        this.logger.log(JSON.stringify({
            event: 'voice.journey.turn_proof',
            callSessionId: p.callSessionId,
            agentId: p.agentId,
            tenantId: p.tenantId,
            userSpeechText: p.userSpeechText,
            openaiKeySource: p.openaiKeySource,
            modelUsed: p.modelUsed,
            openaiCalled: p.openaiCalled,
            openaiSuccess: p.openaiSuccess,
            replyPreview: p.replyPreview,
            voiceProvider: p.voiceProvider,
            voiceIdPresent: p.voiceIdPresent,
            ttsProviderUsed: p.ttsProviderUsed,
            ...(p.intentDetected != null ? { intentDetected: p.intentDetected } : {}),
            ...(p.toolCalled != null ? { toolCalled: p.toolCalled } : {}),
            ...(p.flowStep != null ? { flowStep: p.flowStep } : {}),
            ...(p.state != null ? { state: p.state } : {}),
            ...(p.finalResponseText != null
                ? { finalResponseText: p.finalResponseText.slice(0, 500) }
                : {}),
            ...(p.responseSource != null ? { responseSource: p.responseSource } : {}),
            ...(p.responseMode != null ? { responseMode: p.responseMode } : {}),
            ...(p.templateUsed != null ? { templateUsed: p.templateUsed } : {}),
            ...(p.contextAware != null ? { contextAware: p.contextAware } : {}),
            ...(p.questionAnsweredFirst != null ? { questionAnsweredFirst: p.questionAnsweredFirst } : {}),
            ...(p.interruptionHandled != null ? { interruptionHandled: p.interruptionHandled } : {}),
            ...(p.conversationTone != null ? { conversationTone: p.conversationTone } : {}),
            ...(p.toneLeadUsed !== undefined ? { toneLeadUsed: p.toneLeadUsed } : {}),
            ...(p.paymentSuggestionUsed !== undefined
                ? { paymentSuggestionUsed: p.paymentSuggestionUsed }
                : {}),
            ...(p.followUpTriggered !== undefined ? { followUpTriggered: p.followUpTriggered } : {}),
            ...(p.responseDelayMs !== undefined ? { responseDelayMs: p.responseDelayMs } : {}),
            ...(p.fillerUsed !== undefined ? { fillerUsed: p.fillerUsed } : {}),
            ...(p.openaiUsed !== undefined ? { openaiUsed: p.openaiUsed } : {}),
            ...(p.templateSuppressedBecauseRepeated !== undefined
                ? { templateSuppressedBecauseRepeated: p.templateSuppressedBecauseRepeated }
                : {}),
            ...(p.customerIntentHandled !== undefined
                ? { customerIntentHandled: p.customerIntentHandled }
                : {}),
            ...(p.toolCallAllowed !== undefined ? { toolCallAllowed: p.toolCallAllowed } : {}),
            ...(p.toolCallBlockedReason !== undefined
                ? { toolCallBlockedReason: p.toolCallBlockedReason }
                : {}),
            ...(p.customerQuestionType !== undefined ? { customerQuestionType: p.customerQuestionType } : {}),
            ...(p.responseTemplateUsed != null ? { responseTemplateUsed: p.responseTemplateUsed } : {}),
            humanLikeMode: true,
            roboticTemplateSuppressed: p.templateSuppressedBecauseRepeated === true,
        }));
    }
};
exports.VoiceRuntimeService = VoiceRuntimeService;
exports.VoiceRuntimeService = VoiceRuntimeService = VoiceRuntimeService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [session_context_service_1.SessionContextService,
        calls_service_1.CallsService,
        llm_agent_orchestrator_service_1.LlmAgentOrchestratorService,
        transcript_normalizer_service_1.TranscriptNormalizerService,
        tool_orchestrator_service_1.ToolOrchestratorService,
        call_events_service_1.CallEventsService,
        call_outcome_service_1.CallOutcomeService,
        transcript_buffer_service_1.TranscriptBufferService,
        openai_prompt_builder_service_1.OpenAIPromptBuilderService,
        runtime_safety_service_1.RuntimeSafetyService,
        conversation_flow_engine_service_1.ConversationFlowEngineService,
        conversation_analytics_service_1.ConversationAnalyticsService,
        call_memory_service_1.CallMemoryService,
        policy_context_prefetch_service_1.PolicyContextPrefetchService])
], VoiceRuntimeService);
//# sourceMappingURL=voice-runtime.service.js.map