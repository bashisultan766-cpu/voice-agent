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
var ToolOrchestratorService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolOrchestratorService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../../database/prisma.service");
const client_1 = require("@prisma/client");
const openai_tool_registry_service_1 = require("../../integrations/openai/openai-tool-registry.service");
const retrieval_service_1 = require("../../knowledge/retrieval.service");
const retrieval_orchestrator_service_1 = require("../../knowledge/retrieval-orchestrator.service");
const call_memory_service_1 = require("./call-memory.service");
const call_events_service_1 = require("../../analytics/call-events.service");
const shopify_agent_service_1 = require("../../agents/shopify-agent.service");
const shopify_product_relevance_util_1 = require("../../agents/shopify-product-relevance.util");
const order_booking_service_1 = require("../../agents/order-booking.service");
const client_2 = require("@prisma/client");
const callback_requests_service_1 = require("../callback-requests.service");
const shopify_checkout_service_1 = require("../../integrations/shopify/shopify-checkout.service");
const twilio_sms_service_1 = require("../../integrations/twilio/twilio-sms.service");
const agents_service_1 = require("../../agents/agents.service");
const product_search_1 = require("../../integrations/shopify/product-search");
const resend_email_service_1 = require("../../integrations/email/resend-email.service");
const agent_email_config_service_1 = require("../../integrations/email/agent-email-config.service");
const payment_email_idempotency_1 = require("../../../common/payment-email-idempotency");
const transcript_buffer_service_1 = require("./transcript-buffer.service");
const voice_tool_args_1 = require("../../integrations/openai/voice-tool-args");
const types_1 = require("@bookstore-voice-agents/types");
const types_2 = require("@bookstore-voice-agents/types");
const shopify_ids_1 = require("../../integrations/shopify/shopify-ids");
const checkout_email_policy_util_1 = require("./checkout-email-policy.util");
const language_intelligence_util_1 = require("./language-intelligence.util");
const order_state_machine_util_1 = require("./order-state-machine.util");
const shopify_errors_1 = require("../../integrations/shopify/shopify-errors");
const product_recommendation_util_1 = require("./product-recommendation.util");
const objection_patterns_util_1 = require("./objection-patterns.util");
const voice_email_capture_util_1 = require("./voice-email-capture.util");
const voice_email_enterprise_validation_util_1 = require("./voice-email-enterprise-validation.util");
const enterprise_checkout_state_machine_util_1 = require("./enterprise-checkout-state-machine.util");
const voice_product_query_util_1 = require("../../agents/voice-product-query.util");
const bookstore_voice_query_resolver_util_1 = require("../../search/voice/bookstore-voice-query-resolver.util");
const book_sales_voice_util_1 = require("./book-sales-voice.util");
const voice_stock_sales_policy_util_1 = require("./voice-stock-sales-policy.util");
const llm_agent_conversation_state_util_1 = require("./llm-agent-conversation-state.util");
const voice_pci_guard_util_1 = require("./voice-pci-guard.util");
const voice_checkout_flow_util_1 = require("./voice-checkout-flow.util");
const MAX_TOOL_CALLS_PER_CALL = Number(process.env.MAX_TOOL_CALLS_PER_CALL) || 12;
let ToolOrchestratorService = ToolOrchestratorService_1 = class ToolOrchestratorService {
    constructor(prisma, toolRegistry, retrieval, retrievalOrchestrator, callMemory, callEvents, shopifyAgent, callbacks, booking, checkout, twilioSms, agentsService, productSearch, resendEmail, agentEmailConfig, transcriptBuffer) {
        this.prisma = prisma;
        this.toolRegistry = toolRegistry;
        this.retrieval = retrieval;
        this.retrievalOrchestrator = retrievalOrchestrator;
        this.callMemory = callMemory;
        this.callEvents = callEvents;
        this.shopifyAgent = shopifyAgent;
        this.callbacks = callbacks;
        this.booking = booking;
        this.checkout = checkout;
        this.twilioSms = twilioSms;
        this.agentsService = agentsService;
        this.productSearch = productSearch;
        this.resendEmail = resendEmail;
        this.agentEmailConfig = agentEmailConfig;
        this.transcriptBuffer = transcriptBuffer;
        this.logger = new common_1.Logger(ToolOrchestratorService_1.name);
    }
    mapLiveSummaryToDetailsProduct(live, preferredVariantId) {
        const keys = preferredVariantId?.trim() ? (0, shopify_ids_1.variantIdLookupKeys)(preferredVariantId) : [];
        let selectedVariantId = null;
        const variants = live.variants.map((v) => ({
            variantId: v.id,
            title: v.title,
            sku: v.sku ?? null,
            isbn: v.isbn ?? null,
            price: v.price ?? null,
            compareAtPrice: null,
            inventoryQuantity: v.inventory_quantity,
            availableForSale: v.availableForSale !== false,
        }));
        if (keys.length) {
            const hit = live.variants.find((v) => keys.includes(v.id));
            if (hit)
                selectedVariantId = hit.id;
        }
        const ordered = selectedVariantId != null
            ? [
                variants.find((x) => x.variantId === selectedVariantId),
                ...variants.filter((x) => x.variantId !== selectedVariantId),
            ]
            : variants;
        return {
            productId: live.productId,
            title: live.title,
            handle: live.handle ?? null,
            vendor: null,
            productType: null,
            status: live.status,
            tags: null,
            isbn: live.isbn ?? null,
            selectedVariantId,
            variants: ordered,
            syncedAt: new Date(),
        };
    }
    getStringArg(input, ...keys) {
        for (const key of keys) {
            const value = input[key];
            if (typeof value === 'string' && value.trim())
                return value.trim();
        }
        return '';
    }
    getBooleanArg(input, ...keys) {
        for (const key of keys) {
            const value = input[key];
            if (typeof value === 'boolean')
                return value;
            if (typeof value === 'string') {
                if (value.toLowerCase() === 'true')
                    return true;
                if (value.toLowerCase() === 'false')
                    return false;
            }
        }
        return null;
    }
    normalizeProductQueryText(text) {
        const { cleanedQuery, probableTitle } = (0, voice_product_query_util_1.cleanVoiceProductQuery)(text);
        return (probableTitle || cleanedQuery || text).trim();
    }
    hasSpecificProductSignal(query) {
        const t = query.trim().toLowerCase();
        if (!t)
            return false;
        if (/\b(i need a book|need a book|want a book|any book|some book|book please|find me a book)\b/i.test(t)) {
            return false;
        }
        if (/\b(?:97[89][-\s]?)?\d{9}[\dx]\b/i.test(t))
            return true;
        if (/\bsku[:\s-]*[a-z0-9_-]{3,}\b/i.test(t))
            return true;
        if (/\b(atomic habits|dune|game of thrones)\b/i.test(t))
            return true;
        if (/\b(do you have|check|find|search)\b\s+.{2,}/i.test(t))
            return true;
        if (t.split(/\s+/).length >= 2 && !/\b(sports|electronics|clothes|products|store)\b/i.test(t)) {
            return true;
        }
        return false;
    }
    getSearchToolPolicy(lastUserIntent, query) {
        const intent = (lastUserIntent ?? '').trim().toLowerCase();
        const blockedIntents = new Set([
            'greeting',
            'small_talk',
            'store_identity_question',
            'store_category_question',
            'capability_question',
            'general_business_question',
            'store_policy_question',
            'unclear',
            'unknown',
        ]);
        if (blockedIntents.has(intent)) {
            if (intent === 'store_category_question') {
                return { allowed: false, reason: 'general_category_question' };
            }
            return { allowed: false, reason: `intent_${intent || 'unknown'}_blocked` };
        }
        if (!this.hasSpecificProductSignal(query)) {
            return { allowed: false, reason: 'query_not_specific_enough' };
        }
        return { allowed: true, reason: null };
    }
    normalizeItems(raw) {
        if (!Array.isArray(raw))
            return [];
        return raw
            .map((item) => {
            if (!item || typeof item !== 'object')
                return null;
            const row = item;
            const productId = this.getStringArg(row, 'productId', 'product_id');
            const variantId = this.getStringArg(row, 'variantId', 'variant_id');
            const title = this.getStringArg(row, 'title');
            const quantityRaw = row.quantity;
            const quantity = typeof quantityRaw === 'number' ? quantityRaw : Number(quantityRaw ?? 1);
            if (!productId && !variantId && !title)
                return null;
            return {
                productId: productId || variantId || title,
                variantId: variantId || undefined,
                title: title || undefined,
                quantity: Math.max(1, Number.isFinite(quantity) ? Math.trunc(quantity) : 1),
            };
        })
            .filter((item) => item !== null);
    }
    normalizeEmail(email) {
        return (0, voice_email_capture_util_1.normalizeSpokenEmail)(email);
    }
    async getSessionMetadata(callSessionId) {
        const session = await this.prisma.callSession.findUnique({
            where: { id: callSessionId },
            select: { metadata: true },
        });
        if (!session?.metadata || typeof session.metadata !== 'object' || Array.isArray(session.metadata))
            return {};
        return session.metadata;
    }
    async updateOrderStateMetadata(callSessionId, patch) {
        const metadata = await this.getSessionMetadata(callSessionId);
        const currentState = (0, order_state_machine_util_1.normalizeOrderState)(metadata.orderState);
        const requestedState = patch.orderState ?? currentState;
        const safeState = (0, order_state_machine_util_1.canAdvanceOrderState)(currentState, requestedState) ? requestedState : currentState;
        const merged = {
            ...metadata,
            ...patch,
            orderState: safeState,
        };
        await this.prisma.callSession.update({
            where: { id: callSessionId },
            data: { metadata: merged },
        });
    }
    async execute(ctx, toolName, args, callSessionId, requestId) {
        const summaryInput = JSON.stringify(args ?? {}).slice(0, 400);
        const startSeq = await this.transcriptBuffer.getNextSequence(callSessionId);
        await this.transcriptBuffer.append(callSessionId, 'tool', `Tool call started: ${toolName}(${summaryInput})`, startSeq);
        const start = Date.now();
        this.logger.log(JSON.stringify({
            event: 'voice.tool.execute_start',
            callSessionId,
            toolName,
            tenantId: ctx.tenantId,
            agentId: ctx.agentId,
        }));
        const allowed = this.toolRegistry.isToolAllowed(toolName, {
            enabledTools: ctx.agent.enabledTools,
            toolPermissions: ctx.agent.toolPermissions,
        });
        if (!allowed) {
            const blocked = await this.logAndReturn(ctx, callSessionId, toolName, args, requestId, start, {
                ok: false,
                error: { code: 'TOOL_NOT_ALLOWED', message: 'Tool not enabled for this agent', retryable: false },
                data: {
                    voiceSummary: 'That action is not available on this line right now. I can still answer from our catalog with a quick search, or we can arrange a callback.',
                },
            });
            const blockedSeq = await this.transcriptBuffer.getNextSequence(callSessionId);
            await this.transcriptBuffer.append(callSessionId, 'tool', `Tool call blocked: ${toolName} (${blocked.error?.message ?? 'not allowed'})`, blockedSeq);
            return blocked;
        }
        if (toolName === 'searchProducts') {
            const metadata = await this.getSessionMetadata(callSessionId);
            const lastUserIntent = typeof metadata.lastUserIntent === 'string' ? metadata.lastUserIntent : null;
            const query = this.getStringArg(args, 'query');
            const policy = this.getSearchToolPolicy(lastUserIntent, query);
            if (!policy.allowed) {
                const blocked = await this.logAndReturn(ctx, callSessionId, toolName, args, requestId, start, {
                    ok: false,
                    error: {
                        code: 'TOOL_BLOCKED_BY_INTENT',
                        message: `Search blocked by policy: ${policy.reason ?? 'unspecified'}`,
                        retryable: false,
                    },
                    data: {
                        voiceSummary: "Sure, tell me the book title first and I'll check it for you.",
                        toolCallBlockedReason: policy.reason,
                        toolCallAllowed: false,
                    },
                });
                return blocked;
            }
        }
        const handoffTools = new Set(['escalateToHuman', 'handoff_to_human', 'create_callback_request']);
        if (handoffTools.has(toolName)) {
            const transfersOk = ctx.agent.handoffEnabled !== false && ctx.agent.transferToHumanEnabled !== false;
            if (!transfersOk) {
                return await this.logAndReturn(ctx, callSessionId, toolName, args, requestId, start, {
                    ok: false,
                    error: { code: 'HANDOFF_DISABLED', message: 'Human transfer disabled for this agent', retryable: false },
                    data: {
                        voiceSummary: 'I am not able to transfer this call from here, but I can take your details and have the right person follow up, or answer what I can from our store information.',
                    },
                });
            }
        }
        const parsedArgs = (0, voice_tool_args_1.parseVoiceToolArgs)(toolName, args);
        if (!parsedArgs.ok) {
            return await this.logAndReturn(ctx, callSessionId, toolName, args, requestId, start, {
                ok: false,
                error: {
                    code: 'INVALID_ARGS',
                    message: parsedArgs.message,
                    retryable: false,
                },
                data: {
                    voiceSummary: `I could not run that step—the ${parsedArgs.field ? `${parsedArgs.field.replace(/_/g, ' ')} was` : 'information was'} not quite right. Let me ask for that again, or I can connect you with the team.`,
                },
            });
        }
        const pciAssessment = (0, voice_pci_guard_util_1.assessVoiceToolPciRisk)(toolName, parsedArgs.args);
        if (pciAssessment.blocked) {
            this.logger.warn(JSON.stringify({
                event: 'voice.checkout.pci_blocked',
                callSessionId,
                toolName,
                permissionDecision: pciAssessment.permissionDecision,
                pciRestrictionReason: pciAssessment.pciRestrictionReason,
                safeHostedCheckoutOnly: (0, voice_pci_guard_util_1.isSafeHostedCheckoutOnlyEnabled)(),
            }));
            return await this.logAndReturn(ctx, callSessionId, toolName, args, requestId, start, {
                ok: false,
                error: {
                    code: 'PCI_RESTRICTED',
                    message: 'Sensitive payment details are not allowed in tool arguments.',
                    retryable: false,
                },
                data: {
                    voiceSummary: 'For security, I cannot take card numbers on this call. I can email you a secure Shopify checkout link instead.',
                    pciRestrictionReason: pciAssessment.pciRestrictionReason,
                },
            });
        }
        const fullInput = { ...parsedArgs.args, storeId: ctx.storeId, tenantId: ctx.tenantId };
        try {
            const result = await this.runTool(ctx, toolName, fullInput, callSessionId);
            const logged = await this.logAndReturn(ctx, callSessionId, toolName, fullInput, requestId, start, result);
            await this.callMemory.recordToolCall(callSessionId, toolName, logged.ok);
            const okSeq = await this.transcriptBuffer.getNextSequence(callSessionId);
            await this.transcriptBuffer.append(callSessionId, 'tool', `Tool call completed: ${toolName} (${logged.ok ? 'success' : 'failed'})`, okSeq);
            return logged;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Tool execution failed';
            this.logger.error(JSON.stringify({
                event: 'voice.tool.execute_error',
                callSessionId,
                toolName,
                tenantId: ctx.tenantId,
                agentId: ctx.agentId,
                message: message.slice(0, 300),
            }));
            const failed = await this.logAndReturn(ctx, callSessionId, toolName, fullInput, requestId, start, {
                ok: false,
                error: { code: 'TOOL_ERROR', message, retryable: true },
                data: {
                    voiceSummary: 'I hit a temporary issue while checking that. I can try again, suggest an alternative, or connect you to support.',
                },
            });
            const failSeq = await this.transcriptBuffer.getNextSequence(callSessionId);
            await this.transcriptBuffer.append(callSessionId, 'tool', `Tool call failed: ${toolName} (${message.slice(0, 240)})`, failSeq);
            return failed;
        }
    }
    async runTool(ctx, toolName, input, callSessionId) {
        const noStore = (msg) => ({ ok: true, data: { items: [], voiceSummary: msg }, meta: { source: 'system' } });
        const storeDependent = [
            'get_store_locations',
            'get_store_hours',
            'search_store_faqs',
            'retrieve_knowledge_base',
            'get_shipping_policy',
            'get_return_policy',
            'get_promotion_details',
            'estimate_shipping',
            'get_store_policy',
            'lookup_discount',
        ];
        if (!ctx.storeId && storeDependent.includes(toolName)) {
            return noStore('Store information is not set up for this agent.');
        }
        switch (toolName) {
            case 'normalizeProductQuery': {
                const text = this.getStringArg(input, 'text');
                if (!text) {
                    return {
                        ok: false,
                        error: { code: 'MISSING_INPUT', message: 'Need text to normalize product query.', retryable: true },
                    };
                }
                const normalized = this.normalizeProductQueryText(text);
                return {
                    ok: true,
                    data: {
                        normalizedQuery: normalized || text.trim(),
                        voiceSummary: `I normalized that to: ${normalized || text.trim()}`,
                    },
                    meta: { source: 'system' },
                };
            }
            case 'detectLanguage': {
                const text = this.getStringArg(input, 'text');
                if (!text) {
                    return {
                        ok: false,
                        error: { code: 'MISSING_INPUT', message: 'Need text to detect language.', retryable: true },
                    };
                }
                const detected = (0, language_intelligence_util_1.detectLanguageFromText)(text);
                const language = detected.confidence < 0.55 ? 'en' : detected.language;
                await this.updateOrderStateMetadata(callSessionId, {
                    language,
                    languageConfidence: detected.confidence,
                });
                return {
                    ok: true,
                    data: {
                        language,
                        confidence: detected.confidence,
                        voiceSummary: `Detected language appears to be ${language}.`,
                    },
                    meta: { source: 'deterministic_language_detector' },
                };
            }
            case 'validateEmail': {
                const emailInput = this.getStringArg(input, 'email');
                const validation = (0, voice_email_capture_util_1.validateVoiceEmail)(emailInput);
                const enterprise = await (0, voice_email_enterprise_validation_util_1.validateEnterpriseEmail)(emailInput);
                const email = enterprise.normalized;
                const isValid = enterprise.valid;
                const metadata = await this.getSessionMetadata(callSessionId);
                const currentState = (0, order_state_machine_util_1.normalizeOrderState)(metadata.orderState);
                if (currentState !== 'EMAIL_COLLECTING' && currentState !== 'EMAIL_CONFIRMING') {
                    await this.updateOrderStateMetadata(callSessionId, {
                        orderState: currentState,
                    });
                    return {
                        ok: true,
                        data: {
                            valid: false,
                            normalizedEmail: null,
                            retryCount: Number(metadata.emailRetryCount ?? 0),
                            voiceSummary: 'Let us continue with the book details first, then I will collect your email.',
                        },
                        meta: { source: 'system' },
                    };
                }
                const retries = Number(metadata.emailRetryCount ?? 0);
                const nextRetries = isValid ? retries : retries + 1;
                await this.updateOrderStateMetadata(callSessionId, {
                    normalizedEmail: isValid ? email : '',
                    emailRetryCount: nextRetries,
                    orderState: isValid ? 'EMAIL_CONFIRMING' : 'EMAIL_COLLECTING',
                    emailConfirmationState: isValid ? 'pending' : metadata.emailConfirmationState ?? 'pending',
                });
                this.logger.log(JSON.stringify((0, voice_email_capture_util_1.buildVoiceEmailCaptureLog)({
                    event: 'voice.email.validated',
                    callSessionId,
                    rawPreview: emailInput,
                    normalizedPreview: email,
                    maskedEmail: isValid ? (0, voice_email_capture_util_1.maskEmailForLog)(email) : undefined,
                    valid: isValid,
                    retryCount: nextRetries,
                })));
                this.logger.log(JSON.stringify((0, voice_email_enterprise_validation_util_1.buildEnterpriseEmailValidationLog)({
                    callSessionId,
                    maskedEmail: (0, voice_email_capture_util_1.maskEmailForLog)(email),
                    regexValid: enterprise.regexValid,
                    disposable: enterprise.disposable,
                    mxValid: enterprise.mxValid,
                    mxChecked: enterprise.mxChecked,
                    valid: enterprise.valid,
                    blockedReason: enterprise.blockedReason,
                })));
                let voiceSummary = (0, voice_email_capture_util_1.buildInvalidEmailRetryPrompt)(nextRetries);
                if (enterprise.typoSuggestion) {
                    voiceSummary = (0, voice_email_capture_util_1.buildTypoCorrectionPrompt)(enterprise.typoSuggestion.correctedEmail, enterprise.normalized);
                }
                else if (enterprise.disposable) {
                    voiceSummary = (0, voice_email_capture_util_1.buildDisposableEmailRejectPrompt)();
                }
                else if (enterprise.blockedReason === 'mx_missing') {
                    voiceSummary = (0, voice_email_capture_util_1.buildMxRejectPrompt)();
                }
                else if (isValid) {
                    voiceSummary = (0, voice_email_capture_util_1.buildEmailConfirmationPrompt)(email);
                }
                return {
                    ok: true,
                    data: {
                        valid: isValid,
                        normalizedEmail: isValid ? email : null,
                        retryCount: nextRetries,
                        enterpriseValidation: {
                            disposable: enterprise.disposable,
                            mxValid: enterprise.mxValid,
                            mxChecked: enterprise.mxChecked,
                            blockedReason: enterprise.blockedReason,
                        },
                        voiceSummary,
                    },
                    meta: { source: 'system' },
                };
            }
            case 'searchProducts': {
                const query = this.getStringArg(input, 'query');
                if (!query) {
                    return { ok: false, error: { code: 'MISSING_INPUT', message: 'Need query before searching products.', retryable: true } };
                }
                let effectiveQuery = (0, voice_product_query_util_1.pickVoiceProductSearchQuery)(query, ctx.metadata);
                const llmState = (0, llm_agent_conversation_state_util_1.parseLlmAgentState)(ctx.metadata?.[llm_agent_conversation_state_util_1.LLM_AGENT_STATE_KEY]);
                const memoryResolved = (0, bookstore_voice_query_resolver_util_1.resolveVoiceSearchQueryFromMemory)(effectiveQuery, llmState);
                if (memoryResolved.memoryHit) {
                    effectiveQuery = memoryResolved.effectiveQuery;
                }
                if (effectiveQuery !== query.trim()) {
                    this.logger.log(JSON.stringify({
                        event: 'voice.transcript.search_query_boost',
                        callSessionId,
                        toolQuery: query.slice(0, 200),
                        effectiveQuery: effectiveQuery.slice(0, 200),
                        voiceSearchMemoryHit: memoryResolved.memoryHit,
                    }));
                }
                const objection = (0, objection_patterns_util_1.classifyConversationalObjection)(effectiveQuery);
                const categoryLabel = (0, book_sales_voice_util_1.detectBookCategoryQuery)(effectiveQuery);
                const limit = objection?.type === 'wants_recommendation' ||
                    /\b(recommend|suggest|bestseller|popular)\b/i.test(effectiveQuery)
                    ? 5
                    : categoryLabel
                        ? 3
                        : 3;
                const live = await this.shopifyAgent.searchProducts(ctx.tenantId, ctx.agentId, effectiveQuery, limit);
                if (!live.ok) {
                    return {
                        ok: false,
                        error: {
                            code: 'SHOPIFY_SEARCH_FAILED',
                            message: live.error ?? 'Shopify product search failed.',
                            retryable: true,
                        },
                        data: {
                            voiceSummary: 'I could not search the store catalog right now. Please try again in a moment.',
                        },
                    };
                }
                const items = live.products ?? [];
                const slog = live.searchVoiceLog;
                const topScore = items[0]?.relevanceScore ?? slog?.topScore ?? 0;
                let confidence = 0;
                if (items.length === 0)
                    confidence = 0;
                else if (topScore >= shopify_product_relevance_util_1.PRODUCT_SEARCH_CONFIDENT_MIN_SCORE)
                    confidence = 0.95;
                else if (topScore >= shopify_product_relevance_util_1.PRODUCT_SEARCH_CONFIRM_MIN_SCORE)
                    confidence = 0.78;
                this.logger.log(JSON.stringify({
                    event: 'voice.tool.search_products',
                    eventJourney: 'voice.journey.product_search',
                    callSessionId,
                    tenantId: ctx.tenantId,
                    agentId: ctx.agentId,
                    query,
                    productsFound: items.length,
                    source: 'bookstore_voice_search',
                    productSearchInputRaw: slog?.productSearchInputRaw ?? slog?.queryOriginal,
                    probableTitle: slog?.probableTitle,
                    shopifyQueriesTried: slog?.shopifyQueriesTried,
                    productsReturned: slog?.productsReturned ?? slog?.productsReturnedCount ?? slog?.productsReturnedByShopify,
                    productsReturnedCount: slog?.productsReturnedCount ?? slog?.productsReturnedByShopify,
                    productsAfterRanking: slog?.productsAfterRanking,
                    rankedProducts: slog?.rankedProducts,
                    topProduct: slog?.topProduct ?? slog?.topProductTitle,
                    topProductTitle: slog?.topProductTitle,
                    topScore: slog?.topScore ?? slog?.topRelevanceScore,
                    topMatchReason: slog?.topMatchReason ?? slog?.matchReason,
                    lowConfidenceSearch: slog?.lowConfidenceSearch ?? items.length === 0,
                    finalVoiceSummary: slog?.finalVoiceSummary,
                    fuzzySearchActivated: slog?.bookstoreSearch?.fuzzySearchActivated,
                    semanticSearchUsed: slog?.bookstoreSearch?.semanticSearchUsed,
                    cacheHit: slog?.bookstoreSearch?.cacheHit,
                    searchLatencyMs: slog?.bookstoreSearch?.searchLatencyMs,
                    shopifyLatencyMs: slog?.bookstoreSearch?.shopifyLatencyMs,
                    semanticRankingLatencyMs: slog?.bookstoreSearch?.semanticRankingLatencyMs,
                    cacheLookupMs: slog?.bookstoreSearch?.cacheLookupMs,
                    slowPath: slog?.bookstoreSearch?.slowPath,
                    confidenceTier: slog?.confidenceTier ?? slog?.bookstoreSearch?.confidenceTier,
                    recommendedBooks: slog?.bookstoreSearch?.recommendedBooks,
                }));
                await this.updateOrderStateMetadata(callSessionId, {
                    orderState: 'PRODUCT_SEARCH',
                    productMatchConfidence: confidence,
                    productMatchName: items[0]?.title ?? '',
                });
                if (items.length === 0) {
                    return {
                        ok: true,
                        data: {
                            results: [],
                            confidence: 0,
                            requiresClarification: true,
                            voiceSummary: live.voiceSummary ??
                                `I couldn't find an exact match, but I can check similar titles. Could you repeat the title or author?`,
                        },
                        meta: { source: 'shopify_live' },
                    };
                }
                const mem = await this.callMemory.load(callSessionId);
                const interestSignals = [
                    ...new Set([
                        ...(mem.interestSignals ?? []),
                        ...(0, product_recommendation_util_1.extractInterestSignalsFromText)(query),
                    ]),
                ];
                const enrichedQuery = (0, product_recommendation_util_1.buildRecommendationQueryFromSignals)(query, interestSignals);
                const genres = [
                    ...(mem.preferredGenres ?? []),
                    ...(0, product_recommendation_util_1.extractGenrePreferencesFromText)(enrichedQuery),
                ];
                const recommendable = items.map((p) => ({
                    productId: p.productId,
                    title: p.title,
                    handle: p.handle ?? null,
                    vendor: p.vendor ?? null,
                    productType: p.productType ?? null,
                    tags: Array.isArray(p.tags) ? p.tags.join(', ') : typeof p.tags === 'string' ? p.tags : null,
                    relevanceScore: p.relevanceScore,
                    variants: (p.variants ?? []).map((v) => ({
                        variantId: v.id,
                        price: v.price ?? null,
                        inventoryQuantity: v.inventory_quantity ?? 0,
                        availableForSale: (v.inventory_quantity ?? 0) > 0,
                    })),
                }));
                const ranked = items.length > 1
                    ? (0, product_recommendation_util_1.rankProductRecommendations)(recommendable, {
                        preferredGenres: [...new Set(genres)],
                        rejectedTitles: (mem.rejectedProducts ?? []).map((r) => r.title),
                        mentionedTitles: (mem.discussedProducts ?? mem.mentionedProducts ?? []).map((m) => m.title),
                        queryTokens: enrichedQuery.split(/\s+/).filter((t) => t.length > 1),
                        interestSignals,
                        priceSensitivity: mem.priceSensitivity ?? undefined,
                    })
                    : recommendable;
                const toOffer = (p) => ({
                    title: p.title,
                    variants: p.variants.map((v) => ({
                        price: v.price,
                        inventory_quantity: v.inventory_quantity,
                        availableForSale: v.availableForSale,
                    })),
                });
                const orderedItems = ranked
                    .map((r) => items.find((i) => i.productId === r.productId))
                    .filter((i) => Boolean(i));
                const searchOrder = orderedItems.length > 0 ? orderedItems : items;
                const stockPick = (0, voice_stock_sales_policy_util_1.pickInStockSearchPresentation)(searchOrder, toOffer);
                const primary = stockPick.primary;
                const primaryOffer = toOffer(primary);
                const v0 = primary.variants.find((variant) => (variant.inventory_quantity ?? 0) > 0) ??
                    primary.variants[0];
                const requiresClarification = topScore >= shopify_product_relevance_util_1.PRODUCT_SEARCH_CONFIRM_MIN_SCORE &&
                    topScore < shopify_product_relevance_util_1.PRODUCT_SEARCH_CONFIDENT_MIN_SCORE &&
                    !stockPick.topWasOutOfStock;
                if (v0 && (0, voice_stock_sales_policy_util_1.stockFieldsFromVariants)(primary.variants.map((variant) => ({
                    inventory_quantity: variant.inventory_quantity,
                    availableForSale: variant.availableForSale,
                }))).inStock) {
                    await this.callMemory.recordProduct(callSessionId, {
                        productId: primary.productId,
                        title: primary.title,
                        variantId: v0.id,
                        price: v0.price ?? undefined,
                    });
                    await this.callMemory.updateCart(callSessionId, {
                        productId: primary.productId,
                        title: primary.title,
                        variantId: v0.id,
                        quantity: 1,
                        price: v0.price ?? undefined,
                    });
                }
                let voiceSummary = live.voiceSummary?.trim() ?? '';
                if (!voiceSummary || !/\$|priced at|price|out of stock/i.test(voiceSummary)) {
                    if (categoryLabel && items.length > 1 && !stockPick.topWasOutOfStock) {
                        voiceSummary = (0, book_sales_voice_util_1.formatCategorySearchVoiceSummary)(categoryLabel, items.slice(0, 3).map(toOffer));
                    }
                    else {
                        voiceSummary = (0, voice_stock_sales_policy_util_1.buildProductSearchVoiceSummary)({
                            primary: primaryOffer,
                            topWasOutOfStock: stockPick.topWasOutOfStock,
                            unavailableTitle: stockPick.unavailableTitle,
                            requiresClarification,
                        });
                    }
                }
                const mapResult = (row) => {
                    const stockSnap = (0, voice_stock_sales_policy_util_1.stockFieldsFromVariants)(row.variants.map((variant) => ({
                        inventory_quantity: variant.inventory_quantity,
                        availableForSale: variant.availableForSale,
                    })));
                    return {
                        id: row.productId,
                        title: row.title,
                        handle: row.handle,
                        isbn: row.isbn,
                        relevanceScore: row.relevanceScore,
                        matchReason: row.matchReason,
                        inventoryQuantity: stockSnap.inventoryQuantity,
                        availableForSale: stockSnap.availableForSale,
                        inStock: stockSnap.inStock,
                        variants: row.variants.map((variant) => ({
                            id: variant.id,
                            title: variant.title,
                            sku: variant.sku,
                            isbn: variant.isbn,
                            price: variant.price,
                            inventoryQuantity: variant.inventory_quantity ?? 0,
                            currency: 'USD',
                            availableForSale: (variant.inventory_quantity ?? 0) > 0 && variant.availableForSale !== false,
                        })),
                        primaryVariantId: v0?.id ?? row.variants[0]?.id,
                    };
                };
                const altItems = stockPick.recommendedAlternatives.map(mapResult);
                const primaryStock = (0, voice_stock_sales_policy_util_1.stockFieldsFromVariants)(primary.variants.map((variant) => ({
                    inventory_quantity: variant.inventory_quantity,
                    availableForSale: variant.availableForSale,
                })));
                return {
                    ok: true,
                    data: {
                        results: [mapResult(primary), ...altItems.filter((a) => a.id !== primary.productId)].slice(0, 3),
                        recommendedAlternatives: altItems,
                        topMatchOutOfStock: stockPick.topWasOutOfStock,
                        unavailableTitle: stockPick.unavailableTitle ?? null,
                        confidence,
                        requiresClarification,
                        confirmationQuestion: requiresClarification ? 'Is this the book you meant?' : null,
                        voiceSummary,
                        checkoutAllowed: primaryStock.inStock,
                    },
                    meta: { source: 'shopify_live' },
                };
            }
            case 'getProductDetails': {
                const shopDomain = ctx.agent.shopify?.shopDomain?.trim() ||
                    (0, types_2.normalizeShopifyDomain)(ctx.agent.shopify?.storeUrl ?? null);
                const productIdArg = this.getStringArg(input, 'productId');
                const variantIdArg = this.getStringArg(input, 'variantId');
                const titleArg = this.getStringArg(input, 'title');
                let detailsMeta = 'product_cache';
                let product = await this.productSearch.getDetails(ctx.tenantId, ctx.agentId, {
                    productId: productIdArg,
                    variantId: variantIdArg,
                    title: titleArg,
                }, shopDomain);
                if (!product) {
                    const live = await this.shopifyAgent.getProductLive(ctx.tenantId, ctx.agentId, {
                        productId: productIdArg || undefined,
                        variantId: variantIdArg || undefined,
                        title: titleArg || undefined,
                    });
                    if (live) {
                        product = this.mapLiveSummaryToDetailsProduct(live, variantIdArg || undefined);
                        detailsMeta = 'shopify_live';
                    }
                }
                if (!product) {
                    return {
                        ok: true,
                        data: { product: null, voiceSummary: 'No products found in Shopify store.' },
                        meta: { source: 'shopify_live' },
                    };
                }
                await this.updateOrderStateMetadata(callSessionId, {
                    orderState: 'PRODUCT_DISCOVERY',
                    productMatchName: product.title,
                });
                const selectedId = 'selectedVariantId' in product ? product.selectedVariantId : null;
                return {
                    ok: true,
                    data: {
                        product: {
                            id: product.productId,
                            title: product.title,
                            handle: product.handle,
                            isbn: product.isbn,
                            selectedVariantId: selectedId ?? undefined,
                            variants: product.variants.map((v) => ({
                                id: v.variantId,
                                title: v.title,
                                sku: v.sku,
                                isbn: v.isbn,
                                price: v.price,
                                inventoryQuantity: v.inventoryQuantity,
                                availableForSale: v.availableForSale,
                            })),
                        },
                        voiceSummary: selectedId
                            ? `${product.title}. The variant you asked about is listed first; ${product.variants.length} options in total.`
                            : `${product.title}. ${product.variants.length} variants available.`,
                    },
                    meta: { source: detailsMeta },
                };
            }
            case 'getProductAvailability': {
                const productId = this.getStringArg(input, 'productId');
                const variantId = this.getStringArg(input, 'variantId');
                if (!productId) {
                    return {
                        ok: false,
                        error: { code: 'MISSING_INPUT', message: 'Need productId for availability check.', retryable: true },
                    };
                }
                const shopDomain = ctx.agent.shopify?.shopDomain?.trim() ||
                    (0, types_2.normalizeShopifyDomain)(ctx.agent.shopify?.storeUrl ?? null);
                let availabilityMeta = 'product_cache';
                let product = await this.productSearch.getDetails(ctx.tenantId, ctx.agentId, { productId, variantId: variantId || undefined }, shopDomain);
                if (!product) {
                    const live = await this.shopifyAgent.getProductLive(ctx.tenantId, ctx.agentId, {
                        productId,
                        variantId: variantId || undefined,
                    });
                    if (live) {
                        product = this.mapLiveSummaryToDetailsProduct(live, variantId || undefined);
                        availabilityMeta = 'shopify_live';
                    }
                }
                if (!product) {
                    return {
                        ok: true,
                        data: {
                            available: false,
                            product: null,
                            voiceSummary: 'No products found in Shopify store.',
                        },
                        meta: { source: 'shopify_live' },
                    };
                }
                const targetVariant = variantId
                    ? product.variants.find((v) => v.variantId === variantId)
                    : product.variants[0];
                const available = (targetVariant?.availableForSale ?? false) &&
                    Number(targetVariant?.inventoryQuantity ?? 0) > 0;
                return {
                    ok: true,
                    data: {
                        available,
                        product: {
                            id: product.productId,
                            title: product.title,
                        },
                        variant: targetVariant
                            ? {
                                id: targetVariant.variantId,
                                title: targetVariant.title,
                                price: targetVariant.price,
                                inventoryQuantity: targetVariant.inventoryQuantity,
                                availableForSale: targetVariant.availableForSale,
                            }
                            : null,
                        voiceSummary: targetVariant
                            ? `${product.title} (${targetVariant.title ?? 'default'}): ${available ? 'in stock' : 'currently unavailable'} at ${targetVariant.price ?? 'listed price unavailable'}.`
                            : `${product.title} is available in ${product.variants.length} variants.`,
                    },
                    meta: { source: availabilityMeta },
                };
            }
            case 'createDraftOrder': {
                const metadata = await this.getSessionMetadata(callSessionId);
                const currentState = (0, order_state_machine_util_1.normalizeOrderState)(metadata.orderState);
                if (ToolOrchestratorService_1.ORDER_STATE_SEQUENCE.indexOf(currentState) < ToolOrchestratorService_1.ORDER_STATE_SEQUENCE.indexOf('PRODUCT_DISCOVERY')) {
                    return {
                        ok: false,
                        error: { code: 'PRECONDITION_FAILED', message: 'Product must be confirmed before draft order creation.', retryable: true },
                        data: {
                            voiceSummary: 'Tell me the book title or ISBN first, then we can continue.',
                        },
                    };
                }
                const customerObj = input.customer ?? {};
                const email = this.getStringArg(customerObj, 'email');
                if (!email) {
                    return {
                        ok: false,
                        error: { code: 'MISSING_INPUT', message: 'Need customer.email to create draft order.', retryable: true },
                    };
                }
                const itemsRaw = this.normalizeItems(input.items);
                if (itemsRaw.length === 0) {
                    return {
                        ok: false,
                        error: { code: 'MISSING_INPUT', message: 'Need at least one item for draft order.', retryable: true },
                    };
                }
                let checkout;
                try {
                    checkout = await this.checkout.createCheckoutLink(ctx.tenantId, ctx.agentId, {
                        callSessionId,
                        customer: {
                            email,
                            name: this.getStringArg(customerObj, 'name') || undefined,
                            phone: this.getStringArg(customerObj, 'phone') || undefined,
                        },
                        items: itemsRaw.map((item) => ({
                            variantId: item.variantId ?? item.productId,
                            quantity: item.quantity,
                            title: item.title,
                        })),
                        mode: 'DRAFT_ORDER_INVOICE',
                    });
                }
                catch (err) {
                    const msg = (0, shopify_errors_1.formatShopifyErrorForCaller)(err);
                    return {
                        ok: false,
                        error: { code: 'DRAFT_ORDER_FAILED', message: msg, retryable: true },
                        data: { voiceSummary: msg },
                    };
                }
                await this.updateOrderStateMetadata(callSessionId, {
                    orderState: 'PAYMENT_LINK_CREATING',
                    normalizedEmail: this.normalizeEmail(email),
                    paymentLink: checkout.checkoutUrl,
                });
                return {
                    ok: true,
                    data: {
                        checkoutLinkId: checkout.checkoutLinkId,
                        checkoutUrl: checkout.checkoutUrl,
                        mode: checkout.mode,
                        voiceSummary: `I created a draft-order payment link and can send it to ${email}.`,
                    },
                    meta: { source: 'shopify_checkout' },
                };
            }
            case 'createCheckoutOrInvoicePaymentLink': {
                const order = input.order ?? {};
                const customer = order.customer ?? {};
                const email = this.getStringArg(customer, 'email');
                const itemsRaw = this.normalizeItems(order.items);
                const modeRaw = this.getStringArg(order, 'mode');
                if (!email) {
                    return {
                        ok: false,
                        error: { code: 'MISSING_INPUT', message: 'Need order.customer.email before creating payment link.', retryable: true },
                    };
                }
                if (itemsRaw.length === 0) {
                    return {
                        ok: false,
                        error: { code: 'MISSING_INPUT', message: 'Need order.items before creating payment link.', retryable: true },
                    };
                }
                const mode = modeRaw ? (0, types_1.toCheckoutModeApi)(modeRaw) : undefined;
                const forceNewCheckout = this.getBooleanArg(order, 'forceNewCheckout', 'force_new_checkout') === true;
                let checkout;
                try {
                    checkout = await this.checkout.createCheckoutLink(ctx.tenantId, ctx.agentId, {
                        callSessionId,
                        customer: {
                            email,
                            name: this.getStringArg(customer, 'name') || undefined,
                            phone: this.getStringArg(customer, 'phone') || undefined,
                        },
                        items: itemsRaw.map((item) => ({
                            variantId: item.variantId ?? item.productId,
                            quantity: item.quantity,
                            title: item.title,
                        })),
                        mode,
                        forceNewCheckout,
                    });
                }
                catch (err) {
                    const msg = (0, shopify_errors_1.formatShopifyErrorForCaller)(err);
                    return {
                        ok: false,
                        error: { code: 'CHECKOUT_FAILED', message: msg, retryable: true },
                        data: { voiceSummary: msg },
                    };
                }
                await this.updateOrderStateMetadata(callSessionId, {
                    orderState: 'PAYMENT_LINK_CREATING',
                    normalizedEmail: this.normalizeEmail(email),
                    paymentLink: checkout.checkoutUrl,
                });
                return {
                    ok: true,
                    data: {
                        checkoutLinkId: checkout.checkoutLinkId,
                        checkoutUrl: checkout.checkoutUrl,
                        mode: checkout.mode,
                        reusedExisting: checkout.reusedExisting === true,
                        voiceSummary: `I created a secure ${checkout.mode === 'DRAFT_ORDER_INVOICE' ? 'invoice' : 'checkout'} payment link.`,
                    },
                    meta: { source: 'shopify_checkout' },
                };
            }
            case 'createCheckoutLink': {
                const metadata = await this.getSessionMetadata(callSessionId);
                const llmState = (0, llm_agent_conversation_state_util_1.parseLlmAgentState)(metadata[llm_agent_conversation_state_util_1.LLM_AGENT_STATE_KEY]);
                const stockBlock = (0, voice_stock_sales_policy_util_1.shouldBlockCheckoutForOutOfStock)(llmState);
                if (stockBlock.blocked) {
                    return {
                        ok: false,
                        error: {
                            code: 'OUT_OF_STOCK',
                            message: stockBlock.message ?? 'Selected product is out of stock.',
                            retryable: true,
                        },
                        data: {
                            voiceSummary: 'That title is out of stock, so I cannot start checkout for it. I can recommend another book that is in stock.',
                        },
                    };
                }
                const shopDomain = ctx.agent.shopify?.shopDomain?.trim() ||
                    (0, types_2.normalizeShopifyDomain)(ctx.agent.shopify?.storeUrl ?? null);
                if (!(0, voice_checkout_flow_util_1.voiceCheckoutPreconditionMet)(metadata.orderState, llmState)) {
                    return {
                        ok: false,
                        error: {
                            code: 'PRECONDITION_FAILED',
                            message: 'Product is required before payment link generation.',
                            retryable: true,
                        },
                        data: {
                            voiceSummary: 'Let’s confirm the book first—what title or ISBN?',
                        },
                    };
                }
                const email = this.getStringArg(input, 'email');
                if (!email) {
                    return { ok: false, error: { code: 'MISSING_INPUT', message: 'Need customer email before creating checkout.', retryable: true } };
                }
                const emailValidation = (0, voice_email_capture_util_1.validateVoiceEmail)(email);
                if (!emailValidation.valid) {
                    const retryCount = Number(metadata.emailRetryCount ?? 0) + 1;
                    await this.updateOrderStateMetadata(callSessionId, {
                        emailRetryCount: retryCount,
                        orderState: 'EMAIL_COLLECTING',
                    });
                    return {
                        ok: false,
                        error: {
                            code: 'INVALID_EMAIL',
                            message: 'Email address failed validation.',
                            retryable: true,
                        },
                        data: {
                            voiceSummary: (0, voice_email_capture_util_1.buildInvalidEmailRetryPrompt)(retryCount),
                            deliveryConfirmed: false,
                        },
                    };
                }
                const emailConfirmed = metadata.emailConfirmationState === 'confirmed';
                if (!emailConfirmed) {
                    const pendingEmail = (typeof metadata.normalizedEmail === 'string' ? metadata.normalizedEmail.trim() : '') ||
                        emailValidation.normalized;
                    return {
                        ok: false,
                        error: {
                            code: 'EMAIL_NOT_CONFIRMED',
                            message: 'Customer must confirm email before checkout.',
                            retryable: true,
                        },
                        data: {
                            voiceSummary: pendingEmail
                                ? (0, voice_email_capture_util_1.buildEmailConfirmationPrompt)(pendingEmail)
                                : (0, voice_email_capture_util_1.buildEmailCollectionPrompt)(Number(metadata.emailRetryCount ?? 0)),
                            deliveryConfirmed: false,
                        },
                    };
                }
                (0, enterprise_checkout_state_machine_util_1.assertEmailConfirmedBeforeCheckout)(metadata.emailConfirmationState);
                const checkoutFlow = (0, enterprise_checkout_state_machine_util_1.flowStateFromLlm)(llmState, {
                    emailConfirmationState: 'confirmed',
                    emailEnterpriseValidated: metadata.emailEnterpriseValidated === true,
                });
                if (!(0, enterprise_checkout_state_machine_util_1.canCreatePaymentLink)(checkoutFlow)) {
                    return {
                        ok: false,
                        error: {
                            code: 'CHECKOUT_GUARD',
                            message: 'Product, quantity, validated email, and confirmation required.',
                            retryable: true,
                        },
                        data: {
                            voiceSummary: (0, voice_email_capture_util_1.buildEmailCollectionPrompt)(Number(metadata.emailRetryCount ?? 0)),
                            deliveryConfirmed: false,
                        },
                    };
                }
                let itemsRaw = this.normalizeItems(input.items);
                if (itemsRaw.length === 0) {
                    itemsRaw = (0, voice_checkout_flow_util_1.resolveCheckoutLineItemsFromLlmState)(llmState).map((row) => ({
                        productId: row.productId ?? row.variantId,
                        variantId: row.variantId,
                        title: row.title,
                        quantity: row.quantity,
                    }));
                }
                const checkoutMode = this.getStringArg(input, 'mode').toLowerCase();
                const items = itemsRaw.map((item) => ({
                    variantId: item.variantId ?? item.productId,
                    quantity: item.quantity,
                }));
                if (items.length === 0) {
                    return {
                        ok: false,
                        error: {
                            code: 'MISSING_INPUT',
                            message: 'Need at least one line item with a Shopify variant or product id and quantity. Use getProductDetails first.',
                            retryable: true,
                        },
                        data: {
                            voiceSummary: 'I need the exact product variant from our catalog before I can build checkout. Let me look that up again.',
                        },
                    };
                }
                const configuredMode = checkoutMode ? (0, types_1.toCheckoutModeApi)(checkoutMode) : undefined;
                const forceNewCheckout = this.getBooleanArg(input, 'forceNewCheckout', 'force_new_checkout') === true;
                const primaryVariantId = items[0]?.variantId ?? null;
                this.logger.log(JSON.stringify({
                    event: 'voice.journey.checkout_create_start',
                    callSessionId,
                    tenantId: ctx.tenantId,
                    agentId: ctx.agentId,
                    checkoutProvider: 'shopify',
                    shopifyStore: shopDomain,
                    variantId: primaryVariantId,
                    inventory: llmState.selectedProducts[0]?.stock ?? llmState.lastSearchedProducts[0]?.stock ?? null,
                    checkoutMode: configuredMode ?? 'agent_default',
                    permissionDecision: 'allow_hosted_checkout',
                    hostedCheckout: true,
                    safeHostedCheckoutOnly: (0, voice_pci_guard_util_1.isSafeHostedCheckoutOnlyEnabled)(),
                    itemCount: items.length,
                    forceNewCheckout,
                }));
                let checkout;
                try {
                    checkout = await this.checkout.createCheckoutLink(ctx.tenantId, ctx.agentId, {
                        callSessionId,
                        customer: { email: emailValidation.normalized },
                        items,
                        mode: configuredMode,
                        forceNewCheckout,
                    });
                }
                catch (err) {
                    const msg = (0, shopify_errors_1.formatShopifyErrorForCaller)(err);
                    const retryable = err instanceof shopify_errors_1.ShopifyGraphqlError ? err.retryable : !(err instanceof shopify_errors_1.ShopifyCheckoutValidationError);
                    const errCode = err instanceof shopify_errors_1.ShopifyCheckoutValidationError
                        ? err.code
                        : err instanceof shopify_errors_1.ShopifyGraphqlError
                            ? 'SHOPIFY_GRAPHQL'
                            : 'CHECKOUT_FAILED';
                    this.logger.warn(JSON.stringify({
                        event: 'voice.checkout.create_failed',
                        callSessionId,
                        tenantId: ctx.tenantId,
                        agentId: ctx.agentId,
                        errorCode: 'CHECKOUT_FAILED',
                        shopifyErrorCode: errCode,
                        checkoutProvider: 'shopify',
                        shopifyStore: shopDomain,
                        variantId: primaryVariantId,
                        checkoutMode: configuredMode ?? 'agent_default',
                        permissionDecision: 'allow_hosted_checkout',
                        pciRestrictionReason: null,
                        message: msg.slice(0, 300),
                        retryable,
                    }));
                    const voiceSummary = errCode === 'VARIANT_NOT_IN_CACHE'
                        ? "I'm having trouble generating the checkout link right now, but a human assistant will follow up shortly."
                        : msg;
                    return {
                        ok: false,
                        error: { code: 'CHECKOUT_FAILED', message: msg, retryable },
                        data: {
                            voiceSummary,
                            checkoutFailed: true,
                            doNotRetryProductLookup: true,
                        },
                    };
                }
                const link = await this.prisma.checkoutLink.findUniqueOrThrow({
                    where: { id: checkout.checkoutLinkId },
                });
                this.logger.log(JSON.stringify({
                    event: 'voice.tool.checkout_link_created',
                    eventJourney: 'voice.journey.checkout_link_created',
                    callSessionId,
                    tenantId: ctx.tenantId,
                    agentId: ctx.agentId,
                    checkoutLinkId: link.id,
                    mode: link.mode,
                    itemCount: items.length,
                    reusedExisting: checkout.reusedExisting === true,
                }));
                await this.updateOrderStateMetadata(callSessionId, {
                    orderState: 'PAYMENT_LINK_CREATING',
                    normalizedEmail: this.normalizeEmail(emailValidation.normalized),
                    paymentLink: link.checkoutUrl,
                });
                this.logger.log(JSON.stringify({
                    event: 'voice.payment_link.created',
                    callSessionId,
                    checkoutLinkId: link.id,
                    mode: link.mode,
                }));
                return {
                    ok: true,
                    data: {
                        checkoutLinkId: link.id,
                        checkoutUrl: link.checkoutUrl,
                        mode: link.mode,
                        reusedExisting: checkout.reusedExisting === true,
                        voiceSummary: checkout.reusedExisting === true
                            ? `You already have an open checkout for this cart. Once your email is confirmed, I can resend the secure link.`
                            : `I've prepared your secure checkout. I'll send the payment link to your confirmed email shortly.`,
                    },
                    meta: { source: 'shopify_checkout' },
                };
            }
            case 'sendPaymentEmail': {
                const metadata = await this.getSessionMetadata(callSessionId);
                const checkoutLinkIdInput = this.getStringArg(input, 'checkoutLinkId');
                const email = this.getStringArg(input, 'email');
                const checkoutLinkId = checkoutLinkIdInput;
                if (!email || !checkoutLinkId) {
                    return { ok: false, error: { code: 'MISSING_INPUT', message: 'Need email and checkoutLinkId to send payment email.', retryable: true } };
                }
                const state = (0, order_state_machine_util_1.normalizeOrderState)(metadata.orderState);
                const emailConfirmed = metadata.emailConfirmationState === 'confirmed';
                if (state !== 'PAYMENT_LINK_CREATING' || !emailConfirmed) {
                    return {
                        ok: false,
                        error: {
                            code: 'PRECONDITION_FAILED',
                            message: 'Payment link email requires confirmed email and checkout-ready state.',
                            retryable: true,
                        },
                        data: {
                            voiceSummary: 'Before I send the secure link, please confirm your email first.',
                        },
                    };
                }
                const link = await this.prisma.checkoutLink.findFirst({
                    where: { id: checkoutLinkId, tenantId: ctx.tenantId, agentId: ctx.agentId },
                    include: { agent: { include: { agentConfig: true, client: true } } },
                });
                if (!link)
                    return { ok: false, error: { code: 'NOT_FOUND', message: 'Checkout link not found.', retryable: false } };
                const items = Array.isArray(link.itemsJson)
                    ? link.itemsJson.map((row) => ({
                        title: row.title || 'Selected item',
                        quantity: Math.max(1, Number(row.quantity ?? 1)),
                        price: row.price != null ? String(row.price) : null,
                    }))
                    : [];
                const businessName = link.agent.agentConfig?.businessName?.trim() ||
                    link.agent.client?.name?.trim() ||
                    ctx.store.name;
                const supportEmail = link.agent.agentConfig?.supportEmail || link.agent.client?.contactEmail || null;
                const supportPhone = link.agent.agentConfig?.supportPhone || link.agent.client?.contactPhone || null;
                const emailConfig = await this.agentEmailConfig.resolveForSend(ctx.tenantId, ctx.agentId);
                if (!emailConfig) {
                    return {
                        ok: false,
                        error: {
                            code: 'EMAIL_NOT_CONFIGURED',
                            message: 'Payment email is not configured for this agent.',
                            retryable: false,
                        },
                        data: {
                            voiceSummary: 'I cannot send a payment email right now because email is not set up for this store. Let me connect you with support to complete your order.',
                            escalateRecommended: true,
                        },
                    };
                }
                let sendResult;
                try {
                    sendResult = await this.resendEmail.sendPaymentEmail({
                        tenantId: ctx.tenantId,
                        agentId: ctx.agentId,
                        callSessionId,
                        checkoutLinkId: link.id,
                        idempotencyKey: (0, payment_email_idempotency_1.paymentEmailIdempotencyKey)({
                            tenantId: ctx.tenantId,
                            agentId: ctx.agentId,
                            checkoutLinkId: link.id,
                            recipientEmail: email,
                            purpose: 'voice_tool_send_payment_email',
                        }),
                        to: email,
                        businessName,
                        supportEmail,
                        supportPhone,
                        checkoutUrl: link.checkoutUrl,
                        items,
                        emailConfig,
                    });
                    if (!sendResult.deduplicated) {
                        await this.prisma.checkoutLink.updateMany({
                            where: { id: link.id, tenantId: ctx.tenantId, agentId: ctx.agentId },
                            data: { status: 'SENT', sentAt: new Date() },
                        });
                    }
                }
                catch (err) {
                    const inFlight = err instanceof Error && err.message.includes('already being sent for this checkout');
                    if (inFlight) {
                        return {
                            ok: false,
                            error: {
                                code: 'EMAIL_IN_FLIGHT',
                                message: err instanceof Error ? err.message : 'Email send in progress',
                                retryable: true,
                            },
                            data: {
                                voiceSummary: 'The payment email is still being sent. Please wait a few seconds, check your inbox, or ask me to try again.',
                            },
                        };
                    }
                    await this.prisma.checkoutLink.updateMany({
                        where: { id: link.id, tenantId: ctx.tenantId, agentId: ctx.agentId },
                        data: {
                            status: client_2.CheckoutLinkStatus.FAILED,
                            metadata: {
                                emailSendError: err instanceof Error ? err.message.slice(0, 300) : 'unknown_error',
                            },
                        },
                    });
                    const errorMessage = err instanceof Error ? err.message.slice(0, 300) : 'unknown_error';
                    this.logger.error(JSON.stringify((0, voice_email_capture_util_1.buildVoiceEmailCaptureLog)({
                        event: 'voice.email.send_error',
                        callSessionId,
                        tenantId: ctx.tenantId,
                        agentId: ctx.agentId,
                        maskedEmail: (0, voice_email_capture_util_1.maskEmailForLog)(email),
                        sendOk: false,
                        errorCode: 'EMAIL_SEND_FAILED',
                        errorMessage,
                    })));
                    return {
                        ok: false,
                        error: {
                            code: 'EMAIL_SEND_FAILED',
                            message: errorMessage,
                            retryable: true,
                        },
                        data: {
                            voiceSummary: (0, voice_email_capture_util_1.buildPaymentEmailSendFailurePrompt)(),
                            deliveryConfirmed: false,
                        },
                    };
                }
                if (!sendResult.deduplicated) {
                    await this.prisma.leadCapture.create({
                        data: {
                            tenantId: ctx.tenantId,
                            agentId: ctx.agentId,
                            callSessionId,
                            customerEmail: email,
                            intent: 'purchase_checkout',
                            interestedItems: link.itemsJson ?? client_1.Prisma.JsonNull,
                            metadata: {
                                checkoutLinkId: link.id,
                                checkoutMode: link.mode,
                                emailSent: true,
                            },
                        },
                    });
                }
                const emailApiResult = {
                    success: true,
                    smtpAccepted: true,
                    providerSuccess: Boolean(sendResult.providerMessageId) || sendResult.deduplicated === true,
                    deliveryQueued: sendResult.deduplicated !== true,
                };
                this.logger.log(JSON.stringify((0, voice_email_capture_util_1.buildVoiceEmailCaptureLog)({
                    event: 'voice.email.delivery_confirmed',
                    callSessionId,
                    tenantId: ctx.tenantId,
                    agentId: ctx.agentId,
                    maskedEmail: (0, voice_email_capture_util_1.maskEmailForLog)(email),
                    sendOk: emailApiResult.success,
                    smtpAccepted: emailApiResult.smtpAccepted,
                    providerSuccess: emailApiResult.providerSuccess,
                    deliveryQueued: emailApiResult.deliveryQueued,
                })));
                this.logger.log(JSON.stringify({
                    event: 'voice.tool.payment_email_sent',
                    eventJourney: 'voice.journey.payment_email_sent',
                    callSessionId,
                    tenantId: ctx.tenantId,
                    agentId: ctx.agentId,
                    checkoutLinkId: link.id,
                    recipientEmailMasked: (0, voice_email_capture_util_1.maskEmailForLog)(email),
                    deduplicated: sendResult.deduplicated === true,
                }));
                await this.updateOrderStateMetadata(callSessionId, {
                    orderState: 'PAYMENT_LINK_SENT',
                });
                this.logger.log(JSON.stringify({
                    event: 'voice.payment_email.sent',
                    callSessionId,
                    checkoutLinkId: link.id,
                    deduplicated: sendResult.deduplicated === true,
                }));
                return {
                    ok: emailApiResult.success,
                    data: {
                        deduplicated: sendResult.deduplicated === true,
                        deliveryConfirmed: emailApiResult.success,
                        emailApiResult,
                        voiceSummary: emailApiResult.success && sendResult.deduplicated === true
                            ? `That payment link was already sent to your email. Please check your inbox.`
                            : emailApiResult.success
                                ? (0, voice_email_capture_util_1.buildPaymentEmailSuccessPrompt)()
                                : (0, voice_email_capture_util_1.buildPaymentEmailSendFailurePrompt)(),
                    },
                    meta: { source: 'resend' },
                };
            }
            case 'captureLead': {
                await this.prisma.leadCapture.create({
                    data: {
                        tenantId: ctx.tenantId,
                        agentId: ctx.agentId,
                        callSessionId,
                        customerName: this.getStringArg(input, 'customerName') || null,
                        customerEmail: this.getStringArg(input, 'customerEmail') || null,
                        customerPhone: this.getStringArg(input, 'customerPhone') || null,
                        intent: this.getStringArg(input, 'intent') || null,
                        interestedItems: input.interestedItems ??
                            client_1.Prisma.JsonNull,
                        metadata: input,
                    },
                });
                return { ok: true, data: { voiceSummary: 'I captured your details and will share them with the team.' }, meta: { source: 'database' } };
            }
            case 'escalateToHuman': {
                const reason = this.getStringArg(input, 'reason') || 'customer_requested_human';
                const phone = ctx.fromNumber || this.getStringArg(input, 'phone');
                if (phone) {
                    await this.callbacks.create({
                        tenantId: ctx.tenantId,
                        agentId: ctx.agentId,
                        callSessionId,
                        phone,
                        reason,
                        priority: 'high',
                        notes: 'Escalation requested through new tool.',
                    });
                    await this.callbacks.markRequestedOnSession(callSessionId);
                }
                const msg = 'I can connect you with a human support teammate.';
                return {
                    ok: true,
                    data: { queued: true, reason, message: msg, voiceSummary: msg },
                    meta: { source: 'system' },
                };
            }
            case 'get_order_status': {
                const orderNumber = this.getStringArg(input, 'orderNumber', 'order_number');
                const phone = this.getStringArg(input, 'phone');
                if (!orderNumber) {
                    return { ok: false, error: { code: 'MISSING_INPUT', message: 'Need orderNumber before calling get_order_status.', retryable: true } };
                }
                if (!phone) {
                    return { ok: false, error: { code: 'MISSING_INPUT', message: 'Need phone for verification before order lookup.', retryable: true } };
                }
                const result = await this.shopifyAgent.getOrderStatus(ctx.tenantId, ctx.agentId, orderNumber);
                if (!result.ok)
                    return { ok: false, error: { code: 'SHOPIFY_ERROR', message: result.error ?? 'Order lookup failed.', retryable: true } };
                return { ok: true, data: { verifiedWithPhone: phone.slice(-4), orders: result.orders, voiceSummary: result.voiceSummary }, meta: { source: 'shopify' } };
            }
            case 'search_books': {
                const query = input.query || input.title || '';
                const result = await this.shopifyAgent.searchProducts(ctx.tenantId, ctx.agentId, query, 5);
                if (!result.ok)
                    return { ok: false, error: { code: 'SHOPIFY_ERROR', message: result.error ?? 'Product search failed.', retryable: true } };
                return { ok: true, data: { results: result.products, voiceSummary: result.voiceSummary }, meta: { source: 'shopify' } };
            }
            case 'get_book_details': {
                const query = this.getStringArg(input, 'productId', 'product_id', 'title');
                if (!query) {
                    return { ok: false, error: { code: 'MISSING_INPUT', message: 'Need productId to fetch product details.', retryable: true } };
                }
                const result = await this.shopifyAgent.searchProducts(ctx.tenantId, ctx.agentId, query, 1);
                if (!result.ok)
                    return { ok: false, error: { code: 'SHOPIFY_ERROR', message: result.error ?? 'Product details failed.', retryable: true } };
                const product = result.products?.[0];
                const voiceSummary = product ? `${product.title}. Variants: ${product.variants?.length ?? 0}. ${product.variants?.some((v) => v.inventory_quantity > 0) ? 'In stock.' : 'Out of stock.'}` : 'Product not found.';
                return { ok: true, data: { product, voiceSummary }, meta: { source: 'shopify' } };
            }
            case 'check_book_inventory': {
                const query = this.getStringArg(input, 'productId', 'product_id', 'title', 'query');
                if (!query) {
                    return { ok: false, error: { code: 'MISSING_INPUT', message: 'Need productId to check inventory.', retryable: true } };
                }
                const result = await this.shopifyAgent.searchProducts(ctx.tenantId, ctx.agentId, query, 1);
                if (!result.ok)
                    return { ok: false, error: { code: 'SHOPIFY_ERROR', message: result.error ?? 'Inventory check failed.', retryable: true } };
                const product = result.products?.[0];
                const inStock = product?.variants?.some((v) => v.inventory_quantity > 0) ?? false;
                const voiceSummary = product ? `${product.title}: ${inStock ? 'In stock.' : 'Currently out of stock.'}` : 'Product not found.';
                return { ok: true, data: { inStock, product, voiceSummary }, meta: { source: 'shopify' } };
            }
            case 'get_store_locations': {
                const locs = await this.retrieval.getBranchProfiles(ctx.tenantId, ctx.storeId, input.branchId, input.city);
                return { ok: true, data: { items: locs.items, voiceSummary: locs.voiceSummary, storeName: ctx.store.name }, meta: { source: locs.source } };
            }
            case 'get_store_hours': {
                const hours = await this.retrieval.getStoreHours(ctx.tenantId, ctx.storeId, input.branchId);
                return { ok: true, data: { items: hours.items, voiceSummary: hours.voiceSummary }, meta: { source: hours.source } };
            }
            case 'search_store_faqs':
            case 'retrieve_knowledge_base': {
                const query = input.query || '';
                if (!query.trim()) {
                    return { ok: false, error: { code: 'MISSING_INPUT', message: 'Query required.', retryable: true } };
                }
                try {
                    const rag = await this.retrievalOrchestrator.retrieve({
                        tenantId: ctx.tenantId,
                        storeId: ctx.storeId,
                        query,
                        branchProfileId: input.branchProfileId,
                        topK: 5,
                    });
                    if (rag.ok && rag.items.length > 0) {
                        return {
                            ok: true,
                            data: { items: rag.items, voiceSummary: rag.voiceSummary, source: rag.source },
                            meta: { source: rag.source },
                        };
                    }
                }
                catch {
                }
                const faqs = await this.retrieval.searchFaqs(ctx.tenantId, ctx.storeId, query, input.branchProfileId, 5);
                return { ok: true, data: { items: faqs.items, voiceSummary: faqs.voiceSummary }, meta: { source: faqs.source } };
            }
            case 'get_shipping_policy': {
                const ship = await this.retrieval.getPolicy(ctx.tenantId, ctx.storeId, client_2.KnowledgeDocType.SHIPPING_POLICY, input.branchProfileId);
                return { ok: true, data: { items: ship.items, voiceSummary: ship.voiceSummary }, meta: { source: ship.source } };
            }
            case 'get_return_policy': {
                const ret = await this.retrieval.getPolicy(ctx.tenantId, ctx.storeId, client_2.KnowledgeDocType.RETURN_POLICY, input.branchProfileId);
                return { ok: true, data: { items: ret.items, voiceSummary: ret.voiceSummary }, meta: { source: ret.source } };
            }
            case 'get_promotion_details': {
                const prom = await this.retrieval.getPromotionDetails(ctx.tenantId, ctx.storeId, input.branchProfileId);
                return { ok: true, data: { items: prom.items, voiceSummary: prom.voiceSummary }, meta: { source: prom.source } };
            }
            case 'start_order_booking': {
                const items = this.normalizeItems(input.items);
                if (items.length === 0) {
                    return { ok: false, error: { code: 'MISSING_INPUT', message: 'Need at least one item to start booking.', retryable: true } };
                }
                const draft = await this.booking.startBooking(callSessionId, ctx.tenantId, ctx.agentId, items);
                await this.updateOrderStateMetadata(callSessionId, {
                    orderState: 'PRODUCT_DISCOVERY',
                    quantity: items.reduce((sum, item) => sum + item.quantity, 0),
                });
                return { ok: true, data: { bookingId: draft.id, itemCount: items.length, voiceSummary: `Added ${items.length} item(s) to your order draft.` }, meta: { source: 'database' } };
            }
            case 'set_customer_details': {
                const name = this.getStringArg(input, 'name');
                const phone = this.getStringArg(input, 'phone');
                const email = this.getStringArg(input, 'email');
                if (!name || !phone) {
                    return { ok: false, error: { code: 'MISSING_INPUT', message: 'Need both name and phone for customer details.', retryable: true } };
                }
                await this.booking.setCustomerDetails(callSessionId, ctx.tenantId, ctx.agentId, { name, phone, email: email || undefined });
                await this.updateOrderStateMetadata(callSessionId, {
                    orderState: 'EMAIL_COLLECTION',
                    customerName: name,
                    normalizedEmail: email ? this.normalizeEmail(email) : '',
                });
                return { ok: true, data: { voiceSummary: 'Saved customer details for this order.' }, meta: { source: 'database' } };
            }
            case 'set_delivery_details': {
                const addressLine1 = this.getStringArg(input, 'addressLine1', 'address_line1', 'address');
                const city = this.getStringArg(input, 'city');
                const postalCode = this.getStringArg(input, 'postalCode', 'postal_code', 'zip');
                const country = this.getStringArg(input, 'country');
                if (!addressLine1 || !city) {
                    return { ok: false, error: { code: 'MISSING_INPUT', message: 'Need addressLine1 and city for delivery details.', retryable: true } };
                }
                await this.booking.setDeliveryDetails(callSessionId, ctx.tenantId, ctx.agentId, { addressLine1, city, postalCode: postalCode || undefined, country: country || undefined });
                return { ok: true, data: { voiceSummary: 'Saved delivery details.' }, meta: { source: 'database' } };
            }
            case 'confirm_order_summary': {
                const confirmed = this.getBooleanArg(input, 'confirmed', 'isConfirmed');
                if (confirmed === null) {
                    return { ok: false, error: { code: 'MISSING_INPUT', message: 'Need confirmed=true or confirmed=false.', retryable: true } };
                }
                await this.booking.confirmOrderSummary(callSessionId, ctx.tenantId, ctx.agentId, confirmed);
                await this.updateOrderStateMetadata(callSessionId, {
                    orderState: 'EMAIL_COLLECTION',
                });
                return {
                    ok: true,
                    data: {
                        confirmed,
                        voiceSummary: confirmed
                            ? 'Order summary confirmed. I can now generate your secure payment link.'
                            : 'No problem. I will keep your order as draft until you confirm.',
                    },
                    meta: { source: 'database' },
                };
            }
            case 'create_payment_checkout_link': {
                const draft = await this.booking.getDraft(callSessionId);
                if (!draft || draft.status !== 'READY_FOR_PAYMENT') {
                    return { ok: false, error: { code: 'PRECONDITION_FAILED', message: 'Order must be confirmed before creating checkout link.', retryable: true } };
                }
                const channelRaw = this.getStringArg(input, 'channel').toLowerCase();
                const channel = channelRaw === 'email' ? 'email' : 'sms';
                const destination = this.getStringArg(input, 'destination', channel === 'email' ? 'email' : 'phone', channel === 'email' ? 'phone' : 'email');
                if (!destination) {
                    return { ok: false, error: { code: 'MISSING_INPUT', message: 'Need destination phone/email for checkout link delivery.', retryable: true } };
                }
                const itemsRaw = Array.isArray(draft.itemsJson) ? draft.itemsJson : [];
                const items = itemsRaw
                    .map((row) => {
                    if (!row || typeof row !== 'object')
                        return null;
                    const r = row;
                    return {
                        productId: this.getStringArg(r, 'productId', 'product_id'),
                        variantId: this.getStringArg(r, 'variantId', 'variant_id'),
                        title: this.getStringArg(r, 'title'),
                        quantity: typeof r.quantity === 'number' ? r.quantity : Number(r.quantity ?? 1),
                    };
                })
                    .filter((i) => Boolean(i && (i.productId || i.variantId || i.title)));
                const customer = draft.customerJson ?? {};
                const deliveryAddress = draft.deliveryAddressJson ?? {};
                const customerEmail = this.getStringArg(customer, 'email');
                const customerPhone = this.getStringArg(customer, 'phone');
                const destinationEmail = channel === 'email' ? destination : this.getStringArg(input, 'email');
                const destinationPhone = channel === 'sms' ? destination : this.getStringArg(input, 'phone');
                if ((0, checkout_email_policy_util_1.isEmailRequiredBeforeCheckout)({
                    askEmailBeforePaymentLink: ctx.agent.config?.askEmailBeforePaymentLink,
                    customerEmail,
                    destinationEmail,
                })) {
                    return {
                        ok: false,
                        error: {
                            code: 'EMAIL_REQUIRED',
                            message: 'Customer email is required before sending a payment link.',
                            retryable: true,
                        },
                        data: {
                            requiredField: 'email',
                            voiceSummary: 'Before I send the secure payment link, please share the best email address for your checkout receipt.',
                        },
                    };
                }
                let checkout;
                try {
                    checkout = await this.checkout.createCheckoutLink(ctx.tenantId, ctx.agentId, {
                        callSessionId,
                        items,
                        customer: {
                            name: this.getStringArg(customer, 'name') || undefined,
                            phone: customerPhone || destinationPhone || undefined,
                            email: customerEmail || destinationEmail || undefined,
                        },
                        deliveryAddress: {
                            addressLine1: this.getStringArg(deliveryAddress, 'addressLine1', 'address_line1', 'address') || undefined,
                            city: this.getStringArg(deliveryAddress, 'city') || undefined,
                            postalCode: this.getStringArg(deliveryAddress, 'postalCode', 'postal_code', 'zip') || undefined,
                            country: this.getStringArg(deliveryAddress, 'country') || undefined,
                        },
                    });
                }
                catch (err) {
                    const msg = (0, shopify_errors_1.formatShopifyErrorForCaller)(err);
                    const retryable = err instanceof shopify_errors_1.ShopifyGraphqlError ? err.retryable : !(err instanceof shopify_errors_1.ShopifyCheckoutValidationError);
                    return {
                        ok: false,
                        error: { code: 'CHECKOUT_FAILED', message: msg, retryable },
                        data: { voiceSummary: msg },
                    };
                }
                await this.booking.attachCheckoutLink(callSessionId, checkout.checkoutUrl, channel, destination);
                await this.updateOrderStateMetadata(callSessionId, {
                    orderState: 'EMAIL_COLLECTION',
                    paymentLink: checkout.checkoutUrl,
                });
                const maskedDestination = channel === 'email'
                    ? destination.replace(/^(.).+(@.*)$/, '$1***$2')
                    : destination.replace(/.(?=.{4})/g, '*');
                let channelDeliveryStatus = 'generated';
                let bookingEmailDeduped = false;
                if (channel === 'sms') {
                    const twilioCfg = await this.agentsService.getTwilioConfig(ctx.tenantId, ctx.agentId);
                    const fromNumber = twilioCfg?.messagingFrom?.trim() || this.twilioSms.defaultMessagingFrom();
                    if (!twilioCfg || !fromNumber) {
                        channelDeliveryStatus = 'sms_not_configured';
                    }
                    else {
                        try {
                            await this.twilioSms.sendSms({
                                accountSid: twilioCfg.accountSid,
                                authToken: twilioCfg.authToken,
                                from: fromNumber,
                                to: destination,
                                body: `Secure checkout for ${ctx.store.name}: ${checkout.checkoutUrl}`,
                            });
                            channelDeliveryStatus = 'sms_sent';
                        }
                        catch {
                            channelDeliveryStatus = 'sms_failed';
                        }
                    }
                }
                else {
                    const bookingEmailCfg = await this.agentEmailConfig.resolveForSend(ctx.tenantId, ctx.agentId);
                    if (!bookingEmailCfg) {
                        channelDeliveryStatus = 'email_not_configured';
                    }
                    else {
                        const agentCfg = ctx.agent.config;
                        let businessName = agentCfg?.businessName?.trim() || null;
                        let supportEmail = agentCfg?.supportEmail ?? null;
                        let supportPhone = agentCfg?.supportPhone ?? null;
                        if (!agentCfg?.businessName || !supportEmail || !supportPhone) {
                            const agentContact = await this.prisma.agent.findFirst({
                                where: { id: ctx.agentId, tenantId: ctx.tenantId, deletedAt: null },
                                select: {
                                    client: {
                                        select: {
                                            name: true,
                                            contactEmail: true,
                                            contactPhone: true,
                                        },
                                    },
                                },
                            });
                            businessName = businessName || agentContact?.client?.name?.trim() || null;
                            supportEmail = supportEmail || agentContact?.client?.contactEmail || null;
                            supportPhone = supportPhone || agentContact?.client?.contactPhone || null;
                        }
                        const itemsForEmail = items
                            .map((row) => {
                            if (!row || typeof row !== 'object')
                                return null;
                            const r = row;
                            const title = this.getStringArg(r, 'title') || 'Selected item';
                            const quantity = typeof r.quantity === 'number' ? r.quantity : Number(r.quantity ?? 1);
                            return { title, quantity: Math.max(1, Number.isFinite(quantity) ? Math.trunc(quantity) : 1) };
                        })
                            .filter((i) => i !== null);
                        try {
                            const bookingSend = await this.resendEmail.sendPaymentEmail({
                                tenantId: ctx.tenantId,
                                agentId: ctx.agentId,
                                callSessionId,
                                checkoutLinkId: checkout.checkoutLinkId,
                                idempotencyKey: (0, payment_email_idempotency_1.paymentEmailIdempotencyKey)({
                                    tenantId: ctx.tenantId,
                                    agentId: ctx.agentId,
                                    checkoutLinkId: checkout.checkoutLinkId,
                                    recipientEmail: destination,
                                    purpose: 'voice_tool_booking_checkout_email',
                                }),
                                to: destination,
                                businessName: businessName || ctx.store.name,
                                supportEmail,
                                supportPhone,
                                checkoutUrl: checkout.checkoutUrl,
                                items: itemsForEmail.length > 0 ? itemsForEmail : [{ title: 'Items from your order', quantity: 1 }],
                                emailConfig: bookingEmailCfg,
                            });
                            bookingEmailDeduped = bookingSend.deduplicated === true;
                            await this.prisma.checkoutLink.updateMany({
                                where: {
                                    id: checkout.checkoutLinkId,
                                    tenantId: ctx.tenantId,
                                    agentId: ctx.agentId,
                                },
                                data: { status: 'SENT', sentAt: new Date() },
                            });
                            channelDeliveryStatus = 'email_sent';
                            if (!bookingSend.deduplicated) {
                                await this.prisma.leadCapture.create({
                                    data: {
                                        tenantId: ctx.tenantId,
                                        agentId: ctx.agentId,
                                        callSessionId,
                                        customerEmail: destination.trim().toLowerCase(),
                                        intent: 'purchase_checkout_booking',
                                        interestedItems: draft.itemsJson ?? client_1.Prisma.JsonNull,
                                        metadata: {
                                            checkoutLinkId: checkout.checkoutLinkId,
                                            channel: 'email',
                                        },
                                    },
                                });
                            }
                        }
                        catch (err) {
                            const inFlight = err instanceof Error && err.message.includes('already being sent for this checkout');
                            if (inFlight) {
                                channelDeliveryStatus = 'email_in_progress';
                            }
                            else {
                                channelDeliveryStatus = 'email_failed';
                                await this.prisma.checkoutLink.updateMany({
                                    where: {
                                        id: checkout.checkoutLinkId,
                                        tenantId: ctx.tenantId,
                                        agentId: ctx.agentId,
                                    },
                                    data: { status: client_2.CheckoutLinkStatus.FAILED },
                                });
                            }
                        }
                    }
                }
                const deliveryConfirmed = (channel === 'sms' && channelDeliveryStatus === 'sms_sent') ||
                    (channel === 'email' && channelDeliveryStatus === 'email_sent');
                return {
                    ok: deliveryConfirmed,
                    data: {
                        checkoutUrl: checkout.checkoutUrl,
                        channelDeliveryStatus,
                        deliveryConfirmed,
                        maskedDestination,
                        voiceSummary: channel === 'sms' && channelDeliveryStatus === 'sms_sent'
                            ? `I texted your secure Shopify checkout link to ${maskedDestination}. Please complete payment there.`
                            : channel === 'sms' && channelDeliveryStatus === 'sms_not_configured'
                                ? `I generated your secure checkout link, but SMS is not configured yet. I can read the link aloud or email it if you prefer.`
                                : channel === 'email' && channelDeliveryStatus === 'email_sent' && bookingEmailDeduped
                                    ? `That checkout link was already emailed to ${maskedDestination}. Check your inbox or spam folder.`
                                    : channel === 'email' && channelDeliveryStatus === 'email_sent'
                                        ? `I emailed your secure checkout link to ${maskedDestination}.`
                                        : channel === 'email' && channelDeliveryStatus === 'email_in_progress'
                                            ? `Your checkout email is still sending — please wait a few seconds and check ${maskedDestination}.`
                                            : channel === 'email' && channelDeliveryStatus === 'email_failed'
                                                ? `I created your checkout link but could not send email. I can text the link or read it aloud.`
                                                : `I generated your secure Shopify checkout link.`,
                    },
                    meta: { source: 'shopify' },
                };
            }
            case 'create_callback_request':
                {
                    const phone = this.getStringArg(input, 'phone') || ctx.fromNumber || '';
                    const reason = this.getStringArg(input, 'reason') || 'Caller requested callback';
                    if (!phone)
                        return { ok: false, error: { code: 'MISSING_INPUT', message: 'Need callback phone to create callback request.', retryable: true } };
                    await this.callbacks.create({
                        tenantId: ctx.tenantId,
                        agentId: ctx.agentId,
                        callSessionId,
                        phone,
                        reason,
                        priority: this.getStringArg(input, 'priority'),
                        notes: this.getStringArg(input, 'notes') || undefined,
                    });
                    await this.callbacks.markRequestedOnSession(callSessionId);
                    return {
                        ok: true,
                        data: {
                            queued: true,
                            message: 'Callback request registered. We will call you back shortly.',
                            voiceSummary: 'I have queued a callback with your number. Someone from the team should reach you soon.',
                        },
                        meta: { source: 'database' },
                    };
                }
            case 'search_collections': {
                const query = this.getStringArg(input, 'query') || '';
                const limit = Math.min(Number(input.limit) || 5, 10);
                const shopDomain = ctx.agent.shopify?.shopDomain?.trim() ||
                    (0, types_2.normalizeShopifyDomain)(ctx.agent.shopify?.storeUrl ?? null);
                const products = await this.productSearch.search(ctx.tenantId, ctx.agentId, query, limit, shopDomain);
                const collections = new Map();
                for (const p of products) {
                    const type = p.productType?.trim() || 'General';
                    const prev = collections.get(type) ?? { title: type, count: 0 };
                    prev.count += 1;
                    collections.set(type, prev);
                }
                const items = Array.from(collections.values());
                const voiceSummary = items.length > 0
                    ? `Found ${items.length} categories matching "${query}". Top: ${items[0].title} (${items[0].count} items).`
                    : `No categories found for "${query}" in our catalog.`;
                return { ok: true, data: { items, voiceSummary }, meta: { source: 'shopify_cache' } };
            }
            case 'lookup_variant': {
                const shopDomain = ctx.agent.shopify?.shopDomain?.trim() ||
                    (0, types_2.normalizeShopifyDomain)(ctx.agent.shopify?.storeUrl ?? null);
                const details = await this.productSearch.getDetails(ctx.tenantId, ctx.agentId, {
                    productId: this.getStringArg(input, 'productId') || undefined,
                    variantId: this.getStringArg(input, 'variantId') || undefined,
                    title: undefined,
                }, shopDomain);
                if (!details) {
                    return { ok: false, error: { code: 'NOT_FOUND', message: 'Variant not found.', retryable: false } };
                }
                const sku = this.getStringArg(input, 'sku');
                const variant = sku
                    ? details.variants.find((v) => v.sku?.toLowerCase() === sku.toLowerCase()) ?? details.variants[0]
                    : details.variants[0];
                return {
                    ok: true,
                    data: { product: details, variant, voiceSummary: variant ? `${details.title}, ${variant.title}: ${variant.price ?? 'price on request'}.` : details.title },
                    meta: { source: 'shopify_cache' },
                };
            }
            case 'validate_price': {
                const shopDomain = ctx.agent.shopify?.shopDomain?.trim() ||
                    (0, types_2.normalizeShopifyDomain)(ctx.agent.shopify?.storeUrl ?? null);
                const details = await this.productSearch.getDetails(ctx.tenantId, ctx.agentId, {
                    productId: this.getStringArg(input, 'productId') || undefined,
                    variantId: this.getStringArg(input, 'variantId') || undefined,
                }, shopDomain);
                if (!details) {
                    return { ok: false, error: { code: 'NOT_FOUND', message: 'Product not found.', retryable: false } };
                }
                const quoted = this.getStringArg(input, 'quotedPrice');
                const variant = details.variants[0];
                const actual = variant?.price ?? null;
                const match = quoted && actual ? quoted.replace(/[^\d.]/g, '') === actual.replace(/[^\d.]/g, '') : null;
                return {
                    ok: true,
                    data: {
                        actualPrice: actual,
                        quotedPrice: quoted,
                        priceMatches: match,
                        voiceSummary: actual
                            ? `The correct price is ${actual}${match === false ? ', which differs from what you mentioned.' : '.'}`
                            : 'Price is not available in catalog.',
                    },
                    meta: { source: 'shopify_cache' },
                };
            }
            case 'check_live_inventory': {
                const productId = this.getStringArg(input, 'productId');
                if (!productId) {
                    return { ok: false, error: { code: 'MISSING_INPUT', message: 'productId required.', retryable: true } };
                }
                const live = await this.shopifyAgent.getProductLive(ctx.tenantId, ctx.agentId, {
                    productId,
                    variantId: this.getStringArg(input, 'variantId') || undefined,
                });
                if (!live) {
                    return { ok: false, error: { code: 'SHOPIFY_ERROR', message: 'Inventory check failed.', retryable: true } };
                }
                const variantId = this.getStringArg(input, 'variantId');
                const variant = variantId
                    ? live.variants.find((v) => v.id === variantId) ?? live.variants[0]
                    : live.variants[0];
                const qty = variant?.inventory_quantity ?? 0;
                return {
                    ok: true,
                    data: {
                        inStock: qty > 0,
                        quantity: qty,
                        voiceSummary: qty > 0 ? `${live.title} has ${qty} in stock.` : `${live.title} is currently out of stock.`,
                    },
                    meta: { source: 'shopify_live' },
                };
            }
            case 'lookup_discount': {
                const prom = await this.retrieval.getPromotionDetails(ctx.tenantId, ctx.storeId, undefined);
                const code = this.getStringArg(input, 'code');
                const voiceSummary = prom.items.length > 0
                    ? prom.voiceSummary
                    : code
                        ? `No active promotion found for code "${code}".`
                        : 'No active promotions in our knowledge base right now.';
                return { ok: true, data: { items: prom.items, code, voiceSummary }, meta: { source: prom.source } };
            }
            case 'estimate_shipping': {
                const ship = await this.retrieval.getPolicy(ctx.tenantId, ctx.storeId, client_2.KnowledgeDocType.SHIPPING_POLICY, undefined);
                const city = this.getStringArg(input, 'city');
                const voiceSummary = ship.voiceSummary?.trim()
                    ? `${ship.voiceSummary}${city ? ` (asked about ${city})` : ''}`
                    : 'Shipping estimates follow our store policy—exact rates appear at Shopify checkout.';
                return { ok: true, data: { items: ship.items, city, voiceSummary }, meta: { source: ship.source } };
            }
            case 'get_store_policy': {
                const topic = this.getStringArg(input, 'topic') || 'general';
                const docType = topic === 'shipping'
                    ? client_2.KnowledgeDocType.SHIPPING_POLICY
                    : topic === 'returns'
                        ? client_2.KnowledgeDocType.RETURN_POLICY
                        : client_2.KnowledgeDocType.CUSTOM;
                const policy = await this.retrieval.getPolicy(ctx.tenantId, ctx.storeId, docType, undefined);
                return { ok: true, data: { topic, items: policy.items, voiceSummary: policy.voiceSummary }, meta: { source: policy.source } };
            }
            case 'handoff_to_human': {
                const reason = this.getStringArg(input, 'reason') || 'handoff';
                const phone = ctx.fromNumber || this.getStringArg(input, 'phone');
                if (phone) {
                    await this.callbacks.create({
                        tenantId: ctx.tenantId,
                        agentId: ctx.agentId,
                        callSessionId,
                        phone,
                        reason,
                        priority: 'high',
                        notes: 'Escalation requested during live call.',
                    });
                    await this.callbacks.markRequestedOnSession(callSessionId);
                }
                const msg = ctx.agent.escalationMessage || 'I will connect you with a team member and arrange a callback.';
                return {
                    ok: true,
                    data: { queued: true, reason, message: msg, voiceSummary: msg },
                    meta: { source: 'system' },
                };
            }
            default:
                return {
                    ok: false,
                    error: { code: 'UNKNOWN_TOOL', message: `Unknown tool: ${toolName}`, retryable: false },
                    data: {
                        voiceSummary: 'That specific action is not available on this assistant. I can help with catalog search, checkout by email, order status, or arrange a callback.',
                    },
                };
        }
    }
    async logAndReturn(ctx, callSessionId, toolName, input, requestId, start, result) {
        const latencyMs = Date.now() - start;
        let fullResult = 'storeId' in result ? result : { ...result, toolName, storeId: ctx.storeId ?? null };
        if (!fullResult.ok) {
            const prev = fullResult.data && typeof fullResult.data === 'object' && fullResult.data !== null
                ? fullResult.data
                : {};
            const vs = prev.voiceSummary;
            if (typeof vs !== 'string' || !vs.trim()) {
                fullResult = {
                    ...fullResult,
                    data: {
                        ...prev,
                        voiceSummary: 'I hit a snag while checking that. I can try once more with corrected details, arrange a callback, or connect you with support.',
                    },
                };
            }
        }
        const status = fullResult.ok ? client_2.ToolExecutionStatus.SUCCESS : client_2.ToolExecutionStatus.FAILED;
        this.logger.log(JSON.stringify({
            event: 'voice.tool.execute_finish',
            eventJourney: fullResult.ok ? 'voice.journey.tool_success' : 'voice.journey.tool_failed',
            callSessionId,
            toolName,
            ok: fullResult.ok,
            status,
            latencyMs,
            errorCode: fullResult.error?.code,
        }));
        await this.prisma.toolExecution.create({
            data: {
                tenantId: ctx.tenantId,
                agentId: ctx.agentId,
                callSessionId,
                requestId,
                toolName,
                inputJson: input,
                outputJson: fullResult,
                status,
                errorMessage: fullResult.error?.message,
                latencyMs,
            },
        });
        await this.callEvents.log(ctx.tenantId, callSessionId, fullResult.ok ? client_2.CallEventType.TOOL_SUCCEEDED : client_2.CallEventType.TOOL_FAILED, { toolName, latencyMs, error: fullResult.error?.message });
        return {
            ...fullResult,
            meta: { source: fullResult.meta?.source ?? 'unknown', ...fullResult.meta, latencyMs },
        };
    }
    getMaxToolCallsPerCall() {
        return MAX_TOOL_CALLS_PER_CALL;
    }
};
exports.ToolOrchestratorService = ToolOrchestratorService;
ToolOrchestratorService.ORDER_STATE_SEQUENCE = [
    'IDLE',
    'PRODUCT_SEARCH',
    'PRODUCT_CONFIRMED',
    'QUANTITY_COLLECTED',
    'EMAIL_COLLECTING',
    'EMAIL_CONFIRMING',
    'PAYMENT_LINK_CREATING',
    'PAYMENT_LINK_SENT',
    'DONE',
];
exports.ToolOrchestratorService = ToolOrchestratorService = ToolOrchestratorService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        openai_tool_registry_service_1.OpenAIToolRegistryService,
        retrieval_service_1.RetrievalService,
        retrieval_orchestrator_service_1.RetrievalOrchestratorService,
        call_memory_service_1.CallMemoryService,
        call_events_service_1.CallEventsService,
        shopify_agent_service_1.ShopifyAgentService,
        callback_requests_service_1.CallbackRequestsService,
        order_booking_service_1.OrderBookingService,
        shopify_checkout_service_1.ShopifyCheckoutService,
        twilio_sms_service_1.TwilioSmsService,
        agents_service_1.AgentsService,
        product_search_1.ShopifyProductSearchService,
        resend_email_service_1.ResendEmailService,
        agent_email_config_service_1.AgentEmailConfigService,
        transcript_buffer_service_1.TranscriptBufferService])
], ToolOrchestratorService);
//# sourceMappingURL=tool-orchestrator.service.js.map