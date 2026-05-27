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
const openai_voice_service_1 = require("../../integrations/openai/openai-voice.service");
const openai_prompt_builder_service_1 = require("../../integrations/openai/openai-prompt-builder.service");
const call_events_service_1 = require("../../analytics/call-events.service");
const call_outcome_service_1 = require("../../analytics/call-outcome.service");
const client_1 = require("@prisma/client");
const transcript_buffer_service_1 = require("./transcript-buffer.service");
const redact_voice_input_1 = require("../../../common/redact-voice-input");
const language_intelligence_util_1 = require("./language-intelligence.util");
const order_intent_classifier_util_1 = require("./order-intent-classifier.util");
const order_turn_state_manager_util_1 = require("./order-turn-state-manager.util");
const tool_orchestrator_service_1 = require("./tool-orchestrator.service");
const runtime_safety_service_1 = require("./runtime-safety.service");
const conversation_flow_engine_service_1 = require("./conversation-flow-engine.service");
const conversation_analytics_service_1 = require("./conversation-analytics.service");
const call_memory_service_1 = require("./call-memory.service");
const anti_hallucination_util_1 = require("./anti-hallucination.util");
const voice_speaking_util_1 = require("./voice-speaking.util");
const conversation_stage_util_1 = require("./conversation-stage.util");
const adaptive_voice_behavior_util_1 = require("./adaptive-voice-behavior.util");
const voice_timing_util_1 = require("./voice-timing.util");
const user_intent_classifier_util_1 = require("./user-intent-classifier.util");
const policy_intent_util_1 = require("./policy-intent.util");
const policy_context_prefetch_service_1 = require("./policy-context-prefetch.service");
const checkout_recovery_util_1 = require("./checkout-recovery.util");
const sales_behavior_util_1 = require("./sales-behavior.util");
const runtime_scoring_util_1 = require("./runtime-scoring.util");
const order_state_machine_util_1 = require("./order-state-machine.util");
const professional_voice_response_util_1 = require("./professional-voice-response.util");
const response_mode_util_1 = require("./response-mode.util");
const context_aware_reply_util_1 = require("./context-aware-reply.util");
const conversation_tone_util_1 = require("./conversation-tone.util");
let VoiceRuntimeService = VoiceRuntimeService_1 = class VoiceRuntimeService {
    constructor(sessionContext, callsService, openaiVoice, tools, callEvents, callOutcome, transcriptBuffer, promptBuilder, runtimeSafety, conversationFlow, conversationAnalytics, callMemory, policyPrefetch) {
        this.sessionContext = sessionContext;
        this.callsService = callsService;
        this.openaiVoice = openaiVoice;
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
        const greeting = args.ctx.agent.greetingMessage?.trim() ??
            `Hello, you've reached ${args.ctx.store.name}. How can I help you today?`;
        if (args.userIntent === 'greeting') {
            return greeting;
        }
        if (args.userIntent === 'small_talk') {
            return "I'm doing well, thanks. What book or topic can I help you find?";
        }
        const identity = this.buildConciseIdentityOrCapabilityReply(args.userIntent, args.turnPlan.memory.lastIntent ?? '');
        if (identity)
            return identity;
        if ((0, conversation_stage_util_1.normalizeConversationStage)(args.turnPlan.stage) === 'GREETING') {
            return greeting;
        }
        void args.langCode;
        return null;
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
    buildConciseIdentityOrCapabilityReply(intent, customerText) {
        const t = customerText.trim().toLowerCase();
        if (!t)
            return null;
        const askedHowAreYou = /\bhow\s+(are|r)\s+(you|u|ya)\b/.test(t);
        const askedName = /\b(what('?s| is) your name|who am i speaking with|who is this)\b/.test(t);
        const askedStore = /\b(what store is this|where am i calling|what is your store name|what is this store)\b/.test(t) ||
            intent === 'store_identity_question';
        const askedHelp = /\b(what can you do|how can you help|what do you do|what is your services?|what are your services?)\b/.test(t) ||
            intent === 'capability_question' ||
            intent === 'general_business_question';
        if (!(askedHowAreYou || askedName || askedStore || askedHelp))
            return null;
        const parts = [];
        if (askedHowAreYou)
            parts.push("I'm doing well, thanks for asking.");
        if (askedName)
            parts.push("I'm the voice assistant on this line.");
        if (askedStore)
            parts.push("You're speaking with our store.");
        if (askedHelp) {
            parts.push('I can help with product availability, pricing, orders, and payment links.');
        }
        return parts.join(' ').trim();
    }
    resolveSpokenReplyAfterOpenAI(args) {
        const conciseIdentityOrCapability = this.buildConciseIdentityOrCapabilityReply(args.userIntent, args.customerText);
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
            (args.orderStateAfter === 'PRODUCT_DISCOVERY' || args.orderStateBefore === 'PRODUCT_DISCOVERY')) {
            if (sp.ok && sp.found && !sp.requiresClarification && sp.title) {
                const r = (0, professional_voice_response_util_1.buildProfessionalResponse)({
                    state: 'PRODUCT_DISCOVERY',
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
        if (trace?.validateEmail?.valid === false) {
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
            `Hello, you've reached ${ctx.store.name}. How can I help you today?`;
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
        const safety = this.runtimeSafety.checkUserInput(safeText);
        if (safety.blocked) {
            const reply = this.runtimeSafety.refusalReply(safety.category);
            const ctxEarly = await this.sessionContext.load(callSessionId);
            if (ctxEarly) {
                await this.conversationAnalytics.recordRefusal(ctxEarly.tenantId, callSessionId, safety.category);
            }
            return { reply };
        }
        if (safeText !== text) {
            this.logger.warn(JSON.stringify({
                event: 'voice.journey.payment_data_blocked',
                callSessionId,
            }));
            const reply = 'For your security, I cannot collect card details on this call. I can send a secure Shopify checkout link by SMS or email so you can pay safely there.';
            this.logTurnProof({
                callSessionId,
                tenantId: null,
                agentId: null,
                userSpeechText: safeText.slice(0, 500),
                openaiKeySource: 'n/a',
                modelUsed: 'n/a',
                openaiCalled: false,
                openaiSuccess: false,
                replyPreview: reply.slice(0, 240),
                voiceProvider: null,
                voiceIdPresent: false,
                ttsProviderUsed: null,
                intentDetected: (0, user_intent_classifier_util_1.classifyUserIntent)(safeText),
                toolCalled: false,
                flowStep: 'payment_security_block',
                state: 'n/a',
                finalResponseText: reply,
                responseMode: 'template',
                responseSource: 'template',
                responseTemplateUsed: 'payment_security_block',
                templateUsed: 'payment_security_block',
                openaiUsed: false,
                templateSuppressedBecauseRepeated: false,
            });
            return { reply };
        }
        const ctx = await this.sessionContext.load(callSessionId);
        if (!ctx) {
            this.logger.error(JSON.stringify({
                event: 'voice.journey.session_missing',
                callSessionId,
            }));
            return {
                reply: "I'm sorry, this call session could not be loaded. Please hang up and call again, or contact store support.",
            };
        }
        console.log('[voice-runtime] loaded agent', ctx.agentId, ctx.agent.name);
        console.log('[voice-runtime] using prompt version', ctx.configUpdatedAt ?? 'unknown');
        const metadata = ctx.metadata && typeof ctx.metadata === 'object' && !Array.isArray(ctx.metadata)
            ? ctx.metadata
            : {};
        if (!metadata.orderState) {
            await this.callsService.mergeSessionMetadata(callSessionId, { orderState: 'IDLE' });
        }
        if (!metadata.language && safeText.trim()) {
            const detected = (0, language_intelligence_util_1.detectLanguageFromText)(safeText);
            await this.callsService.mergeSessionMetadata(callSessionId, {
                language: detected.confidence < 0.55 ? 'en' : detected.language,
                languageConfidence: detected.confidence,
            });
        }
        const cls = (0, order_intent_classifier_util_1.classifyOrderTurn)(safeText);
        let userIntent = (0, user_intent_classifier_util_1.classifyUserIntent)(safeText);
        const toolPolicy = this.evaluateSearchToolPolicy(userIntent, safeText);
        const conversationTone = (0, conversation_tone_util_1.detectConversationTone)(safeText);
        const initialLastToneLeadUsed = typeof metadata.lastToneLeadUsed === 'string' ? metadata.lastToneLeadUsed : null;
        const beforeState = metadata.orderState ?? 'IDLE';
        const langCode = typeof metadata.language === 'string'
            ? (metadata.language || 'en')
            : 'en';
        const update = (0, order_turn_state_manager_util_1.applyTurnToOrderState)(beforeState, cls.intent, cls);
        const memBefore = await this.callMemory.load(callSessionId);
        const paymentLinkSent = memBefore.checkoutState === 'link_sent';
        const turnPlan = await this.conversationFlow.planTurn({
            callSessionId,
            userText: safeText,
            orderState: update.nextState,
            orderIntent: cls.intent,
            toolCallAllowed: toolPolicy.toolCallAllowed,
            paymentLinkSent,
        });
        userIntent = turnPlan.userIntent;
        const policyTopic = userIntent === 'store_policy_question' ? (0, policy_intent_util_1.classifyPolicyTopic)(safeText) : null;
        let policyRetrievalSnapshot = null;
        if (userIntent === 'store_policy_question' && ctx.storeId) {
            policyRetrievalSnapshot = await this.policyPrefetch.prefetch({
                tenantId: ctx.tenantId,
                storeId: ctx.storeId,
                customerText: safeText,
                topic: policyTopic,
                config: ctx.agent.config ?? null,
                returnRefundBehavior: ctx.agent.returnRefundBehavior ?? null,
            });
        }
        await this.conversationAnalytics.merge(callSessionId, ctx.tenantId, {
            ...turnPlan.analyticsPatch,
            lastStage: turnPlan.stage,
        });
        await this.callsService.mergeSessionMetadata(callSessionId, {
            orderState: update.nextState,
            lastUserIntent: userIntent,
            customerQuestionType: toolPolicy.customerQuestionType,
            lastTurnIntent: cls.intent,
            lastTurnIntentConfidence: cls.confidence,
            conversationTone,
            conversationStage: turnPlan.stage,
            conversationStageGuidance: turnPlan.stageGuidance,
            salesGuidance: turnPlan.salesGuidance,
            policyTopic: policyTopic ?? undefined,
            policyRetrievalRequired: userIntent === 'store_policy_question',
            policyRetrievalSnapshot: policyRetrievalSnapshot ?? undefined,
            ...(cls.extracted?.quantity != null ? { quantity: cls.extracted.quantity } : {}),
            ...(cls.extracted?.email ? { lastProvidedEmail: cls.extracted.email } : {}),
        });
        if (cls.extracted?.email) {
            await this.callMemory.setEmailState(callSessionId, cls.extracted.email, 'pending');
        }
        if (cls.extracted?.quantity != null && memBefore.cart?.items?.length) {
            const last = memBefore.cart.items[memBefore.cart.items.length - 1];
            if (last) {
                await this.callMemory.updateCart(callSessionId, {
                    ...last,
                    quantity: cls.extracted.quantity,
                });
            }
        }
        if (userIntent === 'purchase_confirmation' &&
            (beforeState === 'IDLE' || beforeState === 'PRODUCT_DISCOVERY')) {
            await this.callsService.mergeSessionMetadata(callSessionId, { orderState: 'EMAIL_COLLECTION' });
            await this.conversationAnalytics.recordCheckoutAttempt(ctx.tenantId, callSessionId);
        }
        const historyFromDb = conversationHistory.length > 0
            ? conversationHistory
            : await this.transcriptBuffer.getConversationHistory(callSessionId, 24);
        const adaptiveBehavior = (0, adaptive_voice_behavior_util_1.resolveAdaptiveVoiceBehavior)(safeText, historyFromDb.length);
        await this.callsService.mergeSessionMetadata(callSessionId, {
            adaptiveCallerMood: adaptiveBehavior.mood,
            adaptiveToneHint: adaptiveBehavior.toneHint,
        });
        this.logger.log(JSON.stringify({
            event: 'voice.journey.turn_start',
            callSessionId,
            tenantId: ctx?.tenantId,
            agentId: ctx?.agentId,
            userChars: safeText.length,
            historyTurns: historyFromDb.length,
            redacted: safeText !== text,
            intentDetected: userIntent,
            customerQuestionType: toolPolicy.customerQuestionType,
            toolCallAllowed: toolPolicy.toolCallAllowed,
            toolCallBlockedReason: toolPolicy.toolCallBlockedReason,
            conversationTone,
        }));
        const userSeq = await this.transcriptBuffer.getNextSequence(callSessionId);
        await this.transcriptBuffer.append(callSessionId, 'user', safeText, userSeq);
        if (turnPlan.useFastVoicePath) {
            const fastReply = this.buildFastVoiceReply({
                userIntent,
                turnPlan,
                ctx,
                langCode,
            });
            if (fastReply) {
                const polished = (0, voice_speaking_util_1.polishVoiceReply)(fastReply, {
                    maxSentences: 2,
                    stage: turnPlan.stage,
                });
                const agentSeq = await this.transcriptBuffer.getNextSequence(callSessionId);
                await this.transcriptBuffer.append(callSessionId, 'agent', polished, agentSeq);
                this.logTurnProof({
                    callSessionId,
                    tenantId: ctx.tenantId,
                    agentId: ctx.agentId,
                    userSpeechText: safeText.slice(0, 500),
                    openaiKeySource: ctx.agent.runtimeCredentialHints?.openaiKeySource ?? 'none',
                    modelUsed: ctx.agent.model ?? 'n/a',
                    openaiCalled: false,
                    openaiSuccess: true,
                    replyPreview: polished.slice(0, 240),
                    voiceProvider: ctx.agent.voiceProvider ?? null,
                    voiceIdPresent: Boolean(ctx.agent.voiceId?.trim()),
                    ttsProviderUsed: null,
                    intentDetected: userIntent,
                    toolCalled: false,
                    flowStep: 'fast_voice_path',
                    state: update.nextState,
                    finalResponseText: polished,
                    responseMode: 'template',
                    responseSource: 'template',
                    responseTemplateUsed: 'fast_voice_path',
                    templateUsed: 'fast_voice_path',
                    openaiUsed: false,
                    templateSuppressedBecauseRepeated: false,
                });
                return { reply: polished };
            }
        }
        if (update.recoveryPrompt) {
            const reply = (0, order_turn_state_manager_util_1.recoveryPromptText)(langCode, update.recoveryPrompt.key);
            const agentSeq = await this.transcriptBuffer.getNextSequence(callSessionId);
            await this.transcriptBuffer.append(callSessionId, 'agent', reply, agentSeq);
            this.logger.log(JSON.stringify({
                event: 'voice.journey.turn_recovered',
                callSessionId,
                intent: cls.intent,
                intentDetected: userIntent,
                toolCalled: false,
                fromState: beforeState,
                toState: update.nextState,
                recoveryKey: update.recoveryPrompt.key,
                flowStep: `recovery_${update.recoveryPrompt.key}`,
                state: update.nextState,
            }));
            this.logTurnProof({
                callSessionId,
                tenantId: ctx?.tenantId ?? null,
                agentId: ctx?.agentId ?? null,
                userSpeechText: safeText.slice(0, 500),
                openaiKeySource: ctx?.agent.runtimeCredentialHints?.openaiKeySource ?? 'none',
                modelUsed: ctx?.agent.model ?? 'n/a',
                openaiCalled: false,
                openaiSuccess: true,
                replyPreview: reply.slice(0, 240),
                voiceProvider: ctx?.agent.voiceProvider ?? null,
                voiceIdPresent: Boolean(ctx?.agent.voiceId?.trim()),
                ttsProviderUsed: null,
                intentDetected: userIntent,
                toolCalled: false,
                flowStep: `recovery_${update.recoveryPrompt.key}`,
                state: update.nextState,
                finalResponseText: reply,
                responseMode: 'template',
                responseSource: 'template',
                responseTemplateUsed: `recovery_${update.recoveryPrompt.key}`,
                templateUsed: `recovery_${update.recoveryPrompt.key}`,
                openaiUsed: false,
                templateSuppressedBecauseRepeated: false,
            });
            return { reply };
        }
        const llmStartedAt = Date.now();
        const result = await this.openaiVoice.processTurn(callSessionId, safeText, historyFromDb);
        const responseDelayMs = Date.now() - llmStartedAt;
        if (result.toolCallsCount > 0) {
            await this.conversationAnalytics.recordToolLatency(ctx.tenantId, callSessionId, responseDelayMs, 'voice_tool_loop');
        }
        const deterministicFallbackActive = this.deterministicFallbackEnabled();
        if (deterministicFallbackActive && result.error?.code === 'OPENAI_429') {
            const preserveOrderState = update.nextState;
            const fb429 = await this.respondDeterministicallyOnOpenAI429({
                callSessionId,
                userText: safeText,
                intent: cls.intent,
                langCode,
                preserveOrderState,
            });
            const reply = fb429.reply;
            const agentSeq = await this.transcriptBuffer.getNextSequence(callSessionId);
            await this.transcriptBuffer.append(callSessionId, 'agent', reply, agentSeq);
            this.logger.log(JSON.stringify({
                event: 'voice.journey.turn_complete',
                callSessionId,
                tenantId: ctx?.tenantId,
                agentId: ctx?.agentId,
                toolCallsCount: result.toolCallsCount,
                replyChars: reply.length,
                escalated: false,
                fallback_used: true,
                reason: 'openai_429',
                intentDetected: userIntent,
                toolCalled: result.toolCallsCount > 0,
                flowStep: 'deterministic_fallback_429',
                state: preserveOrderState,
                finalResponseText: reply.slice(0, 500),
                customerQuestionType: toolPolicy.customerQuestionType,
                toolCallAllowed: toolPolicy.toolCallAllowed,
                toolCallBlockedReason: toolPolicy.toolCallBlockedReason,
                responseSource: fb429.responseSource,
                responseTemplateUsed: fb429.responseTemplateUsed,
                humanLikeMode: true,
                roboticTemplateSuppressed: false,
                openaiUsed: false,
                templateUsed: fb429.responseTemplateUsed,
            }));
            const ctx429 = await this.sessionContext.load(callSessionId);
            const proof429 = {
                callSessionId,
                tenantId: ctx429?.tenantId ?? ctx?.tenantId ?? null,
                agentId: ctx429?.agentId ?? ctx?.agentId ?? null,
                userSpeechText: safeText.slice(0, 500),
                openaiKeySource: result.proof?.openaiKeySource ?? ctx429?.agent.runtimeCredentialHints?.openaiKeySource ?? 'none',
                modelUsed: result.proof?.modelUsed ?? ctx429?.agent.model ?? 'unknown',
                openaiCalled: result.proof?.openaiCalled ?? true,
                openaiSuccess: false,
                replyPreview: reply.slice(0, 240),
                voiceProvider: ctx429?.agent.voiceProvider ?? null,
                voiceIdPresent: Boolean(ctx429?.agent.voiceId?.trim()),
                ttsProviderUsed: null,
                intentDetected: userIntent,
                toolCalled: result.toolCallsCount > 0,
                flowStep: 'deterministic_fallback_429',
                state: preserveOrderState,
                finalResponseText: reply,
                customerQuestionType: toolPolicy.customerQuestionType,
                toolCallAllowed: toolPolicy.toolCallAllowed,
                toolCallBlockedReason: toolPolicy.toolCallBlockedReason,
                responseMode: 'template',
                responseSource: fb429.responseSource,
                responseTemplateUsed: fb429.responseTemplateUsed,
                templateUsed: fb429.responseTemplateUsed,
                openaiUsed: false,
                templateSuppressedBecauseRepeated: false,
            };
            this.logTurnProof(proof429);
            return { reply, turnProof: proof429 };
        }
        const ctxAfterLlm = await this.sessionContext.load(callSessionId);
        const metaAfterLlm = ctxAfterLlm?.metadata && typeof ctxAfterLlm.metadata === 'object' && !Array.isArray(ctxAfterLlm.metadata)
            ? ctxAfterLlm.metadata
            : {};
        const stateForLogOpenAi = (0, order_state_machine_util_1.normalizeOrderState)(metaAfterLlm.orderState ?? update.nextState);
        const stateBeforeNorm = (0, order_state_machine_util_1.normalizeOrderState)(beforeState);
        const followUpOfferedProductKeyForResolve = typeof metaAfterLlm.followUpOfferedProductKey === 'string' && metaAfterLlm.followUpOfferedProductKey.trim()
            ? metaAfterLlm.followUpOfferedProductKey.trim()
            : null;
        const fillerUsedSession = metaAfterLlm.fillerUsed === true;
        const abandonReason = (0, checkout_recovery_util_1.detectCheckoutAbandonReason)(safeText, stateForLogOpenAi);
        if (abandonReason) {
            await this.conversationAnalytics.recordAbandonedStage(ctx.tenantId, callSessionId, turnPlan.stage, abandonReason);
            await this.callsService.mergeSessionMetadata(callSessionId, {
                checkoutRecoveryGuidance: (0, checkout_recovery_util_1.buildCheckoutRecoveryGuidance)(abandonReason, turnPlan.memory),
            });
        }
        const resolved = this.resolveSpokenReplyAfterOpenAI({
            toolTrace: result.toolTrace,
            orderStateAfter: stateForLogOpenAi,
            orderStateBefore: stateBeforeNorm,
            openaiMessage: result.message,
            clsIntent: cls.intent,
            userIntent,
            customerText: safeText,
            conversationHistory: historyFromDb,
            conversationTone,
            lastToneLeadUsed: initialLastToneLeadUsed,
            allowPaymentSuggestion: (0, conversation_tone_util_1.computeAllowPaymentSuggestion)({
                userIntent,
                clsIntent: cls.intent,
                orderState: stateForLogOpenAi,
            }),
            followUpOfferedProductKey: followUpOfferedProductKeyForResolve,
            conversationMemory: turnPlan.memory,
        });
        const memTitles = (turnPlan.memory.discussedProducts ?? turnPlan.memory.mentionedProducts ?? [])
            .map((p) => p.title)
            .filter(Boolean);
        const hallucinationGuard = (0, anti_hallucination_util_1.applyAntiHallucinationGuard)(resolved.reply, result.toolTrace, memTitles);
        if (hallucinationGuard.hallucinationAttempt) {
            const prior = await this.conversationAnalytics.load(callSessionId);
            await this.conversationAnalytics.merge(callSessionId, ctx.tenantId, {
                hallucinationAttempts: (prior.hallucinationAttempts ?? 0) + 1,
            });
        }
        if (result.toolTrace?.searchProducts?.ok && result.toolTrace.searchProducts.found) {
            await this.conversationAnalytics.recordRecommendation(ctx.tenantId, callSessionId, true);
            await this.conversationAnalytics.recordRecommendationOffer(ctx.tenantId, callSessionId);
            if (userIntent === 'purchase_confirmation') {
                await this.conversationAnalytics.recordRecommendationOutcome(ctx.tenantId, callSessionId, true);
                await this.callMemory.merge(callSessionId, {
                    recommendationAccepted: (turnPlan.memory.recommendationAccepted ?? 0) + 1,
                });
            }
        }
        if (result.toolTrace?.sendPaymentEmail?.ok) {
            await this.conversationAnalytics.recordCheckoutConverted(ctx.tenantId, callSessionId);
        }
        const cartItems = turnPlan.memory.cart?.items ?? [];
        let cartValue = 0;
        for (const item of cartItems) {
            const p = parseFloat(String(item.price ?? '').replace(/[^0-9.]/g, ''));
            if (!Number.isNaN(p))
                cartValue += p * (item.quantity ?? 1);
        }
        if (cartValue > 0) {
            await this.conversationAnalytics.recordEstimatedOrderValue(ctx.tenantId, callSessionId, cartValue);
        }
        const salesShapedReply = (0, sales_behavior_util_1.applyHumanSalesBehavior)({
            reply: hallucinationGuard.reply,
            adaptive: adaptiveBehavior,
            stage: turnPlan.stage,
            reassurance: (0, sales_behavior_util_1.confidenceReinforcementPhrase)(turnPlan.stage),
        });
        const polishedReply = (0, voice_speaking_util_1.polishVoiceReply)((0, voice_timing_util_1.applyTimingToChunkText)(salesShapedReply, adaptiveBehavior), {
            maxSentences: adaptiveBehavior.maxSentences,
            stage: turnPlan.stage,
        });
        const analyticsSnap = await this.conversationAnalytics.load(callSessionId);
        const runtimeScores = (0, runtime_scoring_util_1.computeRuntimeScores)({
            stage: turnPlan.stage,
            memory: turnPlan.memory,
            analytics: analyticsSnap,
            hallucinationAttempt: hallucinationGuard.hallucinationAttempt,
            toolCallsCount: result.toolCallsCount,
            searchSucceeded: Boolean(result.toolTrace?.searchProducts?.ok && result.toolTrace.searchProducts.found),
            replyChars: polishedReply.length,
            adaptiveMood: adaptiveBehavior.mood,
            objectionHandled: Boolean(turnPlan.objectionType && resolved.contextAware),
        });
        await this.callsService.mergeSessionMetadata(callSessionId, { runtimeScores });
        const repeatChecked = this.applyRepeatGuard({
            currentReply: polishedReply,
            responseMode: resolved.responseMode,
            responseSource: resolved.responseSource,
            responseTemplateUsed: resolved.responseTemplateUsed,
            previousTemplate: typeof metadata.lastSpokenTemplate === 'string' ? metadata.lastSpokenTemplate : null,
            previousText: typeof metadata.lastSpokenText === 'string' ? metadata.lastSpokenText : null,
            openaiFallbackReply: result.message,
            repeatIndex: typeof metadata.repeatSuppressionCount === 'number' ? metadata.repeatSuppressionCount : 0,
        });
        const agentSeq = await this.transcriptBuffer.getNextSequence(callSessionId);
        await this.transcriptBuffer.append(callSessionId, 'agent', repeatChecked.reply, agentSeq);
        await this.callsService.mergeSessionMetadata(callSessionId, {
            lastToneLeadUsed: resolved.toneLeadUsed ?? null,
            lastSpokenTemplate: repeatChecked.templateUsed,
            lastSpokenText: repeatChecked.reply,
            repeatSuppressionCount: repeatChecked.templateSuppressedBecauseRepeated
                ? typeof metadata.repeatSuppressionCount === 'number'
                    ? metadata.repeatSuppressionCount + 1
                    : 1
                : 0,
            ...(resolved.followUpTriggered && resolved.followUpOfferedProductKey
                ? { followUpOfferedProductKey: resolved.followUpOfferedProductKey }
                : {}),
        });
        this.logger.log(JSON.stringify({
            event: 'voice.journey.turn_complete',
            callSessionId,
            tenantId: ctx?.tenantId,
            agentId: ctx?.agentId,
            toolCallsCount: result.toolCallsCount,
            replyChars: repeatChecked.reply.length,
            escalated: Boolean(result.escalated),
            intentDetected: userIntent,
            toolCalled: result.toolCallsCount > 0,
            flowStep: result.toolCallsCount > 0 ? 'llm_tool_loop' : 'llm_reply',
            state: stateForLogOpenAi,
            finalResponseText: repeatChecked.reply.slice(0, 500),
            contextAware: resolved.contextAware,
            questionAnsweredFirst: resolved.questionAnsweredFirst,
            interruptionHandled: resolved.interruptionHandled,
            conversationTone: resolved.conversationTone,
            toneLeadUsed: resolved.toneLeadUsed,
            paymentSuggestionUsed: resolved.paymentSuggestionUsed,
            followUpTriggered: resolved.followUpTriggered,
            responseDelayMs,
            fillerUsed: fillerUsedSession,
            responseMode: repeatChecked.responseMode,
            responseSource: repeatChecked.responseSource,
            openaiUsed: repeatChecked.openaiUsed,
            customerIntentHandled: true,
            toolCallAllowed: toolPolicy.toolCallAllowed,
            toolCallBlockedReason: toolPolicy.toolCallBlockedReason,
            customerQuestionType: toolPolicy.customerQuestionType,
            templateSuppressedBecauseRepeated: repeatChecked.templateSuppressedBecauseRepeated,
            ...(repeatChecked.templateUsed != null ? { templateUsed: repeatChecked.templateUsed } : {}),
            ...(repeatChecked.templateUsed != null
                ? { responseTemplateUsed: repeatChecked.templateUsed }
                : {}),
            humanLikeMode: true,
            roboticTemplateSuppressed: repeatChecked.templateSuppressedBecauseRepeated,
        }));
        if (result.escalated) {
            const ctx2 = await this.sessionContext.load(callSessionId);
            await this.callsService.updateSessionStatus(callSessionId, {
                escalated: true,
                lastEventAt: new Date(),
                metadata: { endedReason: 'escalated' },
            });
            if (ctx2) {
                await this.callEvents.log(ctx2.tenantId, callSessionId, client_1.CallEventType.ESCALATION_TRIGGERED);
            }
        }
        const turnProof = {
            callSessionId,
            tenantId: ctxAfterLlm?.tenantId ?? ctx?.tenantId ?? null,
            agentId: ctxAfterLlm?.agentId ?? ctx?.agentId ?? null,
            userSpeechText: safeText.slice(0, 500),
            openaiKeySource: result.proof?.openaiKeySource ?? ctxAfterLlm?.agent.runtimeCredentialHints?.openaiKeySource ?? 'none',
            modelUsed: result.proof?.modelUsed ?? ctxAfterLlm?.agent.model ?? 'unknown',
            openaiCalled: result.proof?.openaiCalled ?? true,
            openaiSuccess: result.proof?.openaiSuccess ?? true,
            replyPreview: repeatChecked.reply.slice(0, 240),
            voiceProvider: ctxAfterLlm?.agent.voiceProvider ?? null,
            voiceIdPresent: Boolean(ctxAfterLlm?.agent.voiceId?.trim()),
            ttsProviderUsed: null,
            intentDetected: userIntent,
            toolCalled: result.toolCallsCount > 0,
            flowStep: result.toolCallsCount > 0 ? 'llm_tool_loop' : 'llm_reply',
            state: stateForLogOpenAi,
            finalResponseText: repeatChecked.reply,
            contextAware: resolved.contextAware,
            questionAnsweredFirst: resolved.questionAnsweredFirst,
            interruptionHandled: resolved.interruptionHandled,
            conversationTone: resolved.conversationTone,
            toneLeadUsed: resolved.toneLeadUsed,
            paymentSuggestionUsed: resolved.paymentSuggestionUsed,
            followUpTriggered: resolved.followUpTriggered,
            responseDelayMs,
            fillerUsed: fillerUsedSession,
            responseMode: repeatChecked.responseMode,
            responseSource: repeatChecked.responseSource,
            openaiUsed: repeatChecked.openaiUsed,
            customerIntentHandled: true,
            toolCallAllowed: toolPolicy.toolCallAllowed,
            toolCallBlockedReason: toolPolicy.toolCallBlockedReason,
            customerQuestionType: toolPolicy.customerQuestionType,
            templateSuppressedBecauseRepeated: repeatChecked.templateSuppressedBecauseRepeated,
            ...(repeatChecked.templateUsed != null ? { templateUsed: repeatChecked.templateUsed } : {}),
            ...(repeatChecked.templateUsed != null
                ? { responseTemplateUsed: repeatChecked.templateUsed }
                : {}),
            humanLikeMode: true,
            roboticTemplateSuppressed: repeatChecked.templateSuppressedBecauseRepeated,
        };
        this.logTurnProof(turnProof);
        return { reply: repeatChecked.reply, turnProof };
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
        openai_voice_service_1.OpenAIVoiceService,
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