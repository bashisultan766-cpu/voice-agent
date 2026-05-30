import { Injectable, Logger } from '@nestjs/common';
import { SessionContextService } from './session-context.service';
import { CallsService } from '../calls.service';
import { OpenAIPromptBuilderService } from '../../integrations/openai/openai-prompt-builder.service';
import { LlmAgentOrchestratorService } from './llm-agent-orchestrator.service';
import { TranscriptNormalizerService } from './transcript-normalizer.service';
import { buildLlmReplyMetadataPatch } from './voice-single-reply-pipeline.util';
import { CallEventsService } from '../../analytics/call-events.service';
import { CallOutcomeService } from '../../analytics/call-outcome.service';
import { CallStatus, CallEventType } from '@prisma/client';
import { TranscriptBufferService } from './transcript-buffer.service';
import { redactPaymentLikePatterns } from '../../../common/redact-voice-input';
import { detectLanguageFromText } from './language-intelligence.util';
import { classifyOrderTurn } from './order-intent-classifier.util';
import { applyTurnToOrderState, recoveryPromptText } from './order-turn-state-manager.util';
import { ToolOrchestratorService } from './tool-orchestrator.service';
import { RuntimeSafetyService } from './runtime-safety.service';
import { ConversationFlowEngineService } from './conversation-flow-engine.service';
import { ConversationAnalyticsService } from './conversation-analytics.service';
import { CallMemoryService } from './call-memory.service';
import { applyAntiHallucinationGuard } from './anti-hallucination.util';
import { polishVoiceReply } from './voice-speaking.util';
import {
  buildProfessionalConversationReply,
  classifyConversationRouteIntent,
  sanitizeBannedVoicePhrases,
  shouldUseProfessionalFastReply,
} from './professional-conversation-policy.util';
import { resolveAdaptiveVoiceBehavior } from './adaptive-voice-behavior.util';
import { applyTimingToChunkText } from './voice-timing.util';
import { classifyUserIntent, type UserUtteranceIntent } from './user-intent-classifier.util';
import { classifyPolicyTopic } from './policy-intent.util';
import { PolicyContextPrefetchService } from './policy-context-prefetch.service';
import {
  detectCheckoutAbandonReason,
  buildCheckoutRecoveryGuidance,
  checkoutRecoveryReplySeed,
} from './checkout-recovery.util';
import { applyHumanSalesBehavior, confidenceReinforcementPhrase } from './sales-behavior.util';
import { computeRuntimeScores } from './runtime-scoring.util';
import { normalizeOrderState, type OrderState } from './order-state-machine.util';
import type { ToolResult } from './tool-orchestrator.service';
import { buildProfessionalResponse } from './professional-voice-response.util';
import type { OrderTurnIntent } from './order-intent-classifier.util';
import type { VoiceTurnToolTrace } from './voice-turn-tool-trace.util';
import type { CallConversationMemory } from '@bookstore-voice-agents/types';
import { decideResponseMode } from './response-mode.util';
import { buildContextAwareReply } from './context-aware-reply.util';
import {
  detectConversationTone,
  computeAllowPaymentSuggestion,
  type ConversationTone,
} from './conversation-tone.util';
import type { ProfessionalResponseToneInput } from './professional-voice-response.util';
import {
  buildEmailConfirmationPrompt,
  buildInvalidEmailRetryPrompt,
  buildPaymentEmailSendFailurePrompt,
  isSpellingCaptureActive,
} from './voice-email-capture.util';
import { processTelephonySpellingPipeline } from './telephony-spelling-capture.util';
import {
  buildInstantEngineReply,
  shouldBypassOpenAI,
  shortenVoiceReply,
  VOICE_WORD_LIMITS,
} from './instant-reply.engine';
import { VoiceProductFastPathService } from './voice-product-fast-path.service';
import {
  shouldBypassOpenAIForVoiceTurn,
  shouldSkipNormalizationForProductFastPath,
} from './voice-product-fast-path.util';
import { buildConversationalSupportReply } from './voice-intent-firewall.util';
import { VoiceLatencyAnalyzerService } from './voice-latency-analyzer.service';
import { logVoiceTurnPerformance } from './voice-turn-performance.util';

/**
 * Voice runtime: assembles prompt, handles conversation flow.
 * Step 6: OpenAI chat-with-tools loop for live voice responses.
 */
@Injectable()
export class VoiceRuntimeService {
  private readonly logger = new Logger(VoiceRuntimeService.name);

  constructor(
    private readonly sessionContext: SessionContextService,
    private readonly callsService: CallsService,
    private readonly llmAgent: LlmAgentOrchestratorService,
    private readonly transcriptNormalizer: TranscriptNormalizerService,
    private readonly tools: ToolOrchestratorService,
    private readonly callEvents: CallEventsService,
    private readonly callOutcome: CallOutcomeService,
    private readonly transcriptBuffer: TranscriptBufferService,
    private readonly promptBuilder: OpenAIPromptBuilderService,
    private readonly runtimeSafety: RuntimeSafetyService,
    private readonly conversationFlow: ConversationFlowEngineService,
    private readonly conversationAnalytics: ConversationAnalyticsService,
    private readonly callMemory: CallMemoryService,
    private readonly policyPrefetch: PolicyContextPrefetchService,
    private readonly voiceLatencyAnalyzer: VoiceLatencyAnalyzerService,
    private readonly productFastPath: VoiceProductFastPathService,
  ) {}

  private deterministicFallbackEnabled(): boolean {
    // Always keep deterministic fallback enabled for voice calls to avoid dead-end loops
    // when model providers are rate limited or temporarily unavailable.
    return true;
  }

  private resolveInterruptIntent(
    userIntent: UserUtteranceIntent,
    text: string,
  ): { intent?: 'product_search' | 'order_lookup' | 'support_question' | 'pricing_question'; confidence: number } {
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

  /** Map Shopify search tool output to fixed product / catalog lines (no model copy). */
  private professionalReplyFromSearchTool(
    search: ToolResult,
    tone?: ProfessionalResponseToneInput,
    followUpOfferedProductKey?: string | null,
  ): {
    text: string;
    templateKey: string;
    toneLeadUsed: string | null;
    paymentSuggestionUsed: boolean;
    followUpTriggered?: boolean;
    followUpOfferedProductKey?: string | null;
  } {
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
    const data =
      search.data && typeof search.data === 'object' && !Array.isArray(search.data)
        ? (search.data as Record<string, unknown>)
        : {};
    const results = Array.isArray(data.results) ? (data.results as Record<string, unknown>[]) : [];
    const requiresClarification = data.requiresClarification === true;
    const top = results[0];
    const title = typeof top?.title === 'string' ? top.title : '';
    const variants = Array.isArray(top?.variants) ? (top.variants as Record<string, unknown>[]) : [];
    const v0 = variants[0];
    const price = typeof v0?.price === 'string' ? v0.price : null;
    const found = results.length > 0 && !requiresClarification;
    const r = buildProfessionalResponse({
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

  /** Gentle nudge when the caller is vague but we may still be discussing a product. */
  private appendConversationalMomentum(
    message: string,
    userIntent: UserUtteranceIntent,
    orderState: OrderState,
  ): string {
    const t = message.trim();
    if (!t) return t;
    void userIntent;
    void orderState;
    return polishVoiceReply(t, { maxSentences: 3 });
  }

  private buildFastVoiceReply(args: {
    customerText: string;
    userIntent: UserUtteranceIntent;
    orderState: OrderState;
    toolCallAllowed: boolean;
    turnPlan: Awaited<ReturnType<ConversationFlowEngineService['planTurn']>>;
    ctx: NonNullable<Awaited<ReturnType<SessionContextService['load']>>>;
    langCode: string;
  }): string | null {
    const discussed = args.turnPlan.memory.discussedProducts ?? args.turnPlan.memory.mentionedProducts ?? [];
    const lastTitle = discussed.length > 0 ? discussed[discussed.length - 1]?.title ?? null : null;
    const route = classifyConversationRouteIntent({
      customerText: args.customerText,
      userIntent: args.userIntent,
      orderState: args.orderState,
      storeName: args.ctx.store?.name ?? 'SureShot Books',
      agentName: 'Justin',
      selectedProductTitle: lastTitle,
      hasDiscussedProduct: discussed.length > 0,
    });
    if (!shouldUseProfessionalFastReply(route, args.toolCallAllowed)) {
      return null;
    }
    const reply = buildProfessionalConversationReply(route, {
      customerText: args.customerText,
      userIntent: args.userIntent,
      orderState: args.orderState,
      storeName: args.ctx.store?.name ?? 'SureShot Books',
      agentName: 'Justin',
      selectedProductTitle: lastTitle,
      hasDiscussedProduct: discussed.length > 0,
    });
    if (!reply?.trim()) return null;
    return sanitizeBannedVoicePhrases(reply);
  }

  private normalizeForRepeatCheck(text: string): string {
    return text.trim().replace(/\s+/g, ' ').toLowerCase();
  }

  private hasSpecificProductSignalForSearch(text: string): boolean {
    const t = text.trim().toLowerCase();
    if (!t) return false;
    if (
      /\b(i need a book|need a book|want a book|any book|some book|book please|find me a book)\b/i.test(
        t,
      )
    ) {
      return false;
    }
    if (/\b(?:97[89][-\s]?)?\d{9}[\dx]\b/i.test(t)) return true;
    if (/\bsku[:\s-]*[a-z0-9_-]{3,}\b/i.test(t)) return true;
    if (/\b(do you have|check|find|search)\b\s+.{2,}/i.test(t)) return true;
    if (t.split(/\s+/).length >= 2 && !/\b(sports|electronics|clothes|products|store)\b/i.test(t)) {
      return true;
    }
    return false;
  }

  private evaluateSearchToolPolicy(
    intent: UserUtteranceIntent,
    customerText: string,
  ): { toolCallAllowed: boolean; toolCallBlockedReason: string | null; customerQuestionType: string } {
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
    if (
      intent === 'greeting' ||
      intent === 'small_talk' ||
      intent === 'store_identity_question' ||
      intent === 'capability_question' ||
      intent === 'general_business_question' ||
      intent === 'unclear' ||
      intent === 'unknown'
    ) {
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

  private applyRepeatGuard(args: {
    currentReply: string;
    responseMode: 'template' | 'openai';
    responseSource: 'template' | 'openai';
    responseTemplateUsed?: string;
    previousTemplate?: string | null;
    previousText?: string | null;
    openaiFallbackReply?: string;
    repeatIndex?: number;
  }): {
    reply: string;
    responseMode: 'template' | 'openai';
    responseSource: 'template' | 'openai';
    responseTemplateUsed?: string;
    templateSuppressedBecauseRepeated: boolean;
    templateUsed: string | null;
    openaiUsed: boolean;
  } {
    const previousTemplate = args.previousTemplate?.trim() || null;
    const previousText = args.previousText?.trim() || null;
    const template = args.responseTemplateUsed?.trim() || null;
    const isTemplate = args.responseSource === 'template';
    const duplicateTemplate = Boolean(isTemplate && template && template === previousTemplate);
    const duplicateText =
      Boolean(isTemplate && previousText) &&
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
    const rephrased =
      fallback || this.buildNonRepeatingVariant(args.currentReply, args.repeatIndex ?? 0);
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

  private buildNonRepeatingVariant(reply: string, repeatIndex: number): string {
    const base = reply.trim();
    if (!base) return 'Sure. Tell me a little more so I can help properly.';
    const leads = ['Sure.', 'Of course.', 'Absolutely.', 'Got it.', 'No problem.'];
    const lead = leads[Math.abs(repeatIndex) % leads.length];
    const stripped = base.replace(/^(understood|sure|okay|got it)[,.!\s-]*/i, '').trim();
    if (!stripped) return `${lead} ${base}`;
    return `${lead} ${stripped}`;
  }

  /**
   * Hard guardrail for identity/capability chatter so replies stay concise and professional,
   * even if model output contains long bios or scripted wording.
   */
  private buildConciseIdentityOrCapabilityReply(
    intent: UserUtteranceIntent,
    customerText: string,
    orderState: OrderState = 'IDLE',
  ): string | null {
    const route = classifyConversationRouteIntent({
      customerText,
      userIntent: intent,
      orderState,
      storeName: 'SureShot Books',
      agentName: 'Justin',
    });
    if (
      route !== 'GREETING' &&
      route !== 'SMALL_TALK' &&
      route !== 'WHO_ARE_YOU' &&
      route !== 'HEAR_ME' &&
      route !== 'UNKNOWN_BUSINESS_RELATED'
    ) {
      return null;
    }
    const reply = buildProfessionalConversationReply(route, {
      customerText,
      userIntent: intent,
      orderState,
      storeName: 'SureShot Books',
      agentName: 'Justin',
    });
    return reply ? sanitizeBannedVoicePhrases(reply) : null;
  }

  private logResponsePath(args: {
    callSessionId: string;
    usedOpenAI: boolean;
    usedTemplate: boolean;
    templateReason: string | null;
    intent: string;
    state: string;
    latencyMs: number;
  }): void {
    this.logger.log(
      JSON.stringify({
        event: 'voice.response.path',
        ...args,
      }),
    );
  }

  private resolveSpokenReplyAfterOpenAI(args: {
    toolTrace: VoiceTurnToolTrace | undefined;
    orderStateAfter: OrderState;
    orderStateBefore: OrderState;
    openaiMessage: string;
    clsIntent: OrderTurnIntent;
    userIntent: UserUtteranceIntent;
    customerText: string;
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
    conversationTone: ConversationTone;
    lastToneLeadUsed: string | null;
    allowPaymentSuggestion: boolean;
    followUpOfferedProductKey: string | null;
    conversationMemory?: CallConversationMemory;
  }): {
    reply: string;
    responseMode: 'template' | 'openai';
    responseSource: 'template' | 'openai';
    responseTemplateUsed?: string;
    contextAware: boolean;
    questionAnsweredFirst: boolean;
    interruptionHandled: boolean;
    conversationTone: ConversationTone;
    toneLeadUsed: string | null;
    paymentSuggestionUsed: boolean;
    followUpTriggered: boolean;
    followUpOfferedProductKey: string | null;
  } {
    const conciseIdentityOrCapability = this.buildConciseIdentityOrCapabilityReply(
      args.userIntent,
      args.customerText,
      args.orderStateAfter,
    );
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

    const contextAwareReply = buildContextAwareReply({
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

    const mode = decideResponseMode({
      intent: args.userIntent,
      state: args.orderStateAfter,
      toolResult: args.toolTrace,
      customerText: args.customerText,
    });
    if (mode === 'openai') {
      return {
        reply: this.appendConversationalMomentum(
          args.openaiMessage,
          args.userIntent,
          args.orderStateAfter,
        ),
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
      reply: this.appendConversationalMomentum(
        args.openaiMessage,
        args.userIntent,
        args.orderStateAfter,
      ),
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

  private buildTemplateReply(args: {
    trace: VoiceTurnToolTrace | undefined;
    orderStateAfter: OrderState;
    orderStateBefore: OrderState;
    clsIntent: OrderTurnIntent;
    tone?: ProfessionalResponseToneInput;
    allowPaymentSuggestion?: boolean;
    followUpOfferedProductKey?: string | null;
  }): {
    text: string;
    templateKey: string;
    toneLeadUsed: string | null;
    paymentSuggestionUsed: boolean;
    followUpTriggered: boolean;
    followUpOfferedProductKey: string | null;
  } | null {
    const trace = args.trace;
    const tone = args.tone;
    const allowPay = args.allowPaymentSuggestion === true;
    const followUpKey = args.followUpOfferedProductKey ?? null;
    if (trace?.sendPaymentEmail?.ok) {
      const r = buildProfessionalResponse({
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
        text: buildPaymentEmailSendFailurePrompt(),
        templateKey: 'payment_email_failed',
        toneLeadUsed: null,
        paymentSuggestionUsed: false,
        followUpTriggered: false,
        followUpOfferedProductKey: null,
      };
    }
    const sp = trace?.searchProducts;
    if (
      sp &&
      (args.orderStateAfter === 'PRODUCT_SEARCH' ||
        args.orderStateBefore === 'PRODUCT_SEARCH' ||
        args.orderStateAfter === 'PRODUCT_DISCOVERY' ||
        args.orderStateBefore === 'PRODUCT_DISCOVERY')
    ) {
      if (sp.ok && sp.found && !sp.requiresClarification && sp.title) {
        const r = buildProfessionalResponse({
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
    if (
      trace?.validateEmail?.valid === false &&
      (args.orderStateAfter === 'EMAIL_COLLECTING' ||
        args.orderStateAfter === 'EMAIL_CONFIRMING' ||
        args.orderStateAfter === 'EMAIL_COLLECTION')
    ) {
      return {
        text: buildInvalidEmailRetryPrompt(1),
        templateKey: 'invalid_email',
        toneLeadUsed: null,
        paymentSuggestionUsed: false,
        followUpTriggered: false,
        followUpOfferedProductKey: null,
      };
    }
    if (
      trace?.validateEmail?.valid === true &&
      trace.validateEmail.email &&
      (args.orderStateAfter === 'EMAIL_CONFIRMING' || args.orderStateAfter === 'EMAIL_COLLECTING')
    ) {
      return {
        text: buildEmailConfirmationPrompt(trace.validateEmail.email),
        templateKey: 'email_confirm',
        toneLeadUsed: null,
        paymentSuggestionUsed: false,
        followUpTriggered: false,
        followUpOfferedProductKey: null,
      };
    }
    return null;
  }

  private isDeliveryQuestion(text: string): boolean {
    const t = text.toLowerCase();
    return (
      t.includes('delivery') ||
      t.includes('deliver') ||
      t.includes('shipping') ||
      t.includes('ship') ||
      t.includes('delivery times') ||
      t.includes('when will') ||
      t.includes('tempo di consegna') ||
      t.includes('consegna') ||
      t.includes('spedizione') ||
      t.includes('доставка') ||
      t.includes('достав')
    );
  }

  private async respondDeterministicallyOnOpenAI429(args: {
    callSessionId: string;
    userText: string;
    intent: string;
    langCode: string;
    preserveOrderState: string;
  }): Promise<{ reply: string; responseSource: 'template'; responseTemplateUsed: string }> {
    const ctx = await this.sessionContext.load(args.callSessionId);
    if (!ctx) {
      return {
        reply: "I'm sorry, I couldn't load your session. Please try again.",
        responseSource: 'template',
        responseTemplateUsed: 'fallback_429_session_missing',
      };
    }

    this.logger.warn(
      JSON.stringify({
        event: 'voice.journey.deterministic_fallback_used',
        callSessionId: args.callSessionId,
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        fallback_used: true,
        reason: 'openai_429',
        intent: args.intent,
      }),
    );
    await this.callEvents.log(ctx.tenantId, args.callSessionId, CallEventType.FALLBACK_USED, {
      reason: 'openai_429',
      deterministicFallback: true,
      intent: args.intent,
    });

    // Preserve the state set by the per-turn state manager (do not allow tool side-effects to jump the flow).
    const preserveState = async () => {
      await this.callsService.mergeSessionMetadata(args.callSessionId, {
        orderState: args.preserveOrderState,
        deterministicFallback: true,
        deterministicFallbackReason: 'openai_429',
      });
    };

    // 1) Deterministic product search + availability summary
    if (args.intent === 'product_search') {
      const search = await this.tools.execute(
        ctx,
        'searchProducts',
        { query: args.userText, limit: 5 },
        args.callSessionId,
        'deterministic_fallback_search',
      );
      await preserveState();
      if (!search.ok) {
        const b = this.professionalReplyFromSearchTool(search);
        return { reply: b.text, responseSource: 'template', responseTemplateUsed: b.templateKey };
      }
      const data =
        search.data && typeof search.data === 'object' && !Array.isArray(search.data)
          ? (search.data as Record<string, unknown>)
          : {};
      const confidence = typeof data.confidence === 'number' ? data.confidence : null;
      const requiresClarification = data.requiresClarification === true;
      if (requiresClarification || (confidence !== null && confidence < 0.45)) {
        const r = buildProfessionalResponse({
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

    // 2) Delivery FAQ from store config (no hallucination)
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
        reply:
          "I don't have verified delivery timing details available right now. I can take your details for a callback, or you can check the shipping policy on the store website.",
        responseSource: 'template',
        responseTemplateUsed: 'delivery_faq_unavailable',
      };
    }

    // 3) Polite refusal for checkout/payment without LLM
    if (
      args.intent === 'order_confirmed' ||
      args.intent === 'email_provided' ||
      args.intent === 'quantity_provided' ||
      args.intent === 'variant_selected'
    ) {
      return {
        reply:
          "I'm temporarily unable to complete checkout steps right now. I can still help you find products and confirm availability, or connect you with the team to finalize payment.",
        responseSource: 'template',
        responseTemplateUsed: 'fallback_429_checkout_blocked',
      };
    }

    return {
      reply:
        "I'm temporarily unable to complete that step right now. I can still help search products and confirm availability.",
      responseSource: 'template',
      responseTemplateUsed: 'fallback_429_generic',
    };
  }

  /** Persist instant turn in background — not on Twilio hot path. */
  async recordInstantTurn(args: {
    callSessionId: string;
    userText: string;
    reply: string;
    userIntent: UserUtteranceIntent;
  }): Promise<number> {
    const dbStart = Date.now();
    const userSeq = await this.transcriptBuffer.getNextSequence(args.callSessionId);
    await this.transcriptBuffer.append(args.callSessionId, 'user', args.userText, userSeq);
    const agentSeq = await this.transcriptBuffer.getNextSequence(args.callSessionId);
    await this.transcriptBuffer.append(args.callSessionId, 'agent', args.reply, agentSeq);
    await this.callsService.mergeSessionMetadata(args.callSessionId, {
      ...buildLlmReplyMetadataPatch(args.reply),
      instant_reply_used: true,
      openaiCalled: false,
      lastIntentDetected: args.userIntent,
    });
    return Date.now() - dbStart;
  }

  async getGreeting(callSessionId: string): Promise<string> {
    const ctx = await this.sessionContext.load(callSessionId);
    if (!ctx) return "Hello, I'm having trouble loading your session. Please try again.";
    const greeting =
      ctx.agent.greetingMessage?.trim() ??
      'Hello, this is Justin with SureShot Books. How can I help you find or order a book today?';
    return greeting;
  }

  async buildSystemPrompt(callSessionId: string): Promise<string> {
    const ctx = await this.sessionContext.load(callSessionId);
    if (!ctx) return 'You are a helpful voice assistant.';
    return this.promptBuilder.build(ctx);
  }

  async onRuntimeConnected(callSessionId: string): Promise<void> {
    const existing = await this.callsService.findOneById(callSessionId);
    if (existing.status === CallStatus.IN_PROGRESS) {
      return;
    }
    const ctx = await this.sessionContext.load(callSessionId);
    await this.callsService.updateSessionStatus(callSessionId, {
      status: CallStatus.IN_PROGRESS,
      answeredAt: new Date(),
      lastEventAt: new Date(),
    });
    if (ctx) {
      console.log('[voice-runtime] loaded agent', ctx.agentId, ctx.agent.name);
      console.log('[voice-runtime] using prompt version', ctx.configUpdatedAt ?? 'unknown');
      await this.callEvents.log(ctx.tenantId, callSessionId, CallEventType.TWILIO_CONNECTED);
      await this.callEvents.log(ctx.tenantId, callSessionId, CallEventType.OPENAI_SESSION_STARTED);
      this.logger.log(
        JSON.stringify({
          event: 'voice.journey.session_active',
          callSessionId,
          tenantId: ctx.tenantId,
          agentId: ctx.agentId,
          agentName: ctx.agent.name,
          configUpdatedAt: ctx.configUpdatedAt,
        }),
      );
    }
  }

  async onRuntimeDisconnected(callSessionId: string): Promise<void> {
    const session = await this.callsService.findOneById(callSessionId);
    if (session.endedAt) {
      return;
    }
    const endedAt = new Date();
    const durationSeconds =
      session.startedAt ? Math.floor((endedAt.getTime() - new Date(session.startedAt).getTime()) / 1000) : undefined;
    await this.callsService.updateSessionStatus(callSessionId, {
      status: CallStatus.COMPLETED,
      endedAt,
      durationSeconds,
      lastEventAt: endedAt,
    });
    await this.callEvents.log(session.tenantId, callSessionId, CallEventType.CALL_COMPLETED, {
      durationSeconds,
      escalated: session.escalated,
    });
    const metaEnd = (session.metadata ?? {}) as Record<string, unknown>;
    const memEnd = metaEnd.conversationMemory as Record<string, unknown> | undefined;
    const stage =
      typeof memEnd?.conversationStage === 'string'
        ? memEnd.conversationStage
        : typeof metaEnd.conversationStage === 'string'
          ? metaEnd.conversationStage
          : 'unknown';
    if (session.status === CallStatus.COMPLETED || session.status === CallStatus.ABANDONED) {
      await this.conversationAnalytics.recordAbandonedStage(session.tenantId, callSessionId, stage);
    }
    await this.callOutcome.deriveAndUpsert(callSessionId);
    this.logger.log(
      JSON.stringify({
        event: 'voice.journey.session_completed',
        callSessionId,
        tenantId: session.tenantId,
        durationSeconds,
        escalated: session.escalated,
      }),
    );
  }

  /**
   * Process caller speech after inbound greeting.
   * Single brain path: LlmAgentOrchestratorService.handleTurn (OpenAI + tools).
   */
  async processUtterance(
    callSessionId: string,
    text: string,
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [],
  ): Promise<{
    reply: string;
    turnProof?: Record<string, unknown>;
  }> {
    const turnStartedAt = Date.now();
    const safeText = redactPaymentLikePatterns(text);
    const trimmedUserText = safeText.trim();
    let reply = '';
    let openaiLatencyMs: number | undefined;
    let intentLatencyMs: number | undefined;
    const safety = this.runtimeSafety.checkUserInput(safeText);
    if (safety.blocked) {
      reply = this.runtimeSafety.refusalReply(safety.category);
      const ctxEarly = await this.sessionContext.load(callSessionId);
      if (ctxEarly) {
        await this.conversationAnalytics.recordRefusal(
          ctxEarly.tenantId,
          callSessionId,
          safety.category,
        );
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
      this.logger.error(
        JSON.stringify({
          event: 'voice.journey.session_missing',
          callSessionId,
        }),
      );
      reply =
        "I'm sorry, this call session could not be loaded. Please hang up and call again, or contact store support.";
      this.logger.error(
        JSON.stringify({
          event: 'voice.brain.bypass_detected',
          sessionId: callSessionId,
          userText: trimmedUserText.slice(0, 500),
          reason: 'session_missing',
        }),
      );
      return { reply };
    }

    const historyFromDb =
      conversationHistory.length > 0
        ? conversationHistory
        : await this.transcriptBuffer.getConversationHistory(callSessionId, 24);

    const sessionRowEarly = await this.callsService.findOneById(callSessionId);
    const sessionMetaEarly =
      sessionRowEarly.metadata &&
      typeof sessionRowEarly.metadata === 'object' &&
      !Array.isArray(sessionRowEarly.metadata)
        ? (sessionRowEarly.metadata as Record<string, unknown>)
        : {};

    const intentStartedAt = Date.now();
    const [userIntent, langCode] = await Promise.all([
      Promise.resolve(classifyUserIntent(trimmedUserText)),
      Promise.resolve(detectLanguageFromText(trimmedUserText).language),
    ]);
    intentLatencyMs = Date.now() - intentStartedAt;

    const orderStateForInstant =
      typeof sessionMetaEarly.orderState === 'string' ? sessionMetaEarly.orderState : 'IDLE';
    const bypass = shouldBypassOpenAI({
      text: trimmedUserText,
      orderState: orderStateForInstant,
      spellingCaptureActive: isSpellingCaptureActive(sessionMetaEarly),
    });
    if (bypass.bypass && bypass.openaiSkippedReason === 'instant_deterministic_reply') {
      const storeName = ctx.store?.name ?? 'SureShot Books';
      reply = shortenVoiceReply(
        polishVoiceReply(buildInstantEngineReply(trimmedUserText, storeName), { maxSentences: 2, maxChars: 120 }),
        VOICE_WORD_LIMITS.simple,
      );
      const userSeqInstant = await this.transcriptBuffer.getNextSequence(callSessionId);
      await this.transcriptBuffer.append(callSessionId, 'user', trimmedUserText, userSeqInstant);
      const agentSeqInstant = await this.transcriptBuffer.getNextSequence(callSessionId);
      await this.transcriptBuffer.append(callSessionId, 'agent', reply, agentSeqInstant);
      await this.callsService.mergeSessionMetadata(callSessionId, {
        ...buildLlmReplyMetadataPatch(reply),
        instant_reply_used: true,
        openaiCalled: false,
        lastIntentDetected: userIntent,
      });

      const totalTurnLatencyMs = Date.now() - turnStartedAt;
      this.voiceLatencyAnalyzer.recordBreakdown({
        callSessionId,
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        route: 'instant_reply',
        intentDetectionMs: intentLatencyMs,
        instantReplyMs: Date.now() - turnStartedAt - intentLatencyMs,
        normalizationMs: 0,
        openaiMs: 0,
        totalCallerWaitMs: totalTurnLatencyMs,
        instantReplyUsed: true,
        openaiCalled: false,
        ttsGenerated: false,
        openaiSkippedReason: bypass.openaiSkippedReason,
      });
      logVoiceTurnPerformance({
        callSessionId,
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        totalTurnLatencyMs,
        intentLatencyMs,
        openaiLatencyMs: 0,
        instantReplyUsed: true,
        openaiCalled: false,
        cacheHit: false,
        slowPathReason: totalTurnLatencyMs >= 2000 ? 'instant_path_slow' : null,
      });

      this.logger.log(
        JSON.stringify({
          event: 'voice.brain.selected',
          agentId: ctx.agentId,
          sessionId: callSessionId,
          tenantId: ctx.tenantId,
          brain: 'instant_reply',
          instant_reply_used: true,
          openaiCalled: false,
          userIntent,
          langCode,
        }),
      );

      const turnProof = {
        callSessionId,
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        userSpeechText: safeText.slice(0, 500),
        openaiCalled: false,
        openaiSuccess: true,
        instant_reply_used: true,
        instantReplyUsed: true,
        replyPreview: reply.slice(0, 240),
        flowStep: 'instant_reply',
        brain: 'instant_reply',
        totalTurnLatencyMs,
        intentLatencyMs,
      };
      this.logTurnProof({
        callSessionId,
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        userSpeechText: safeText.slice(0, 500),
        openaiKeySource: 'none',
        modelUsed: 'n/a',
        openaiCalled: false,
        openaiSuccess: true,
        replyPreview: reply.slice(0, 240),
        voiceProvider: ctx.agent.voiceProvider ?? null,
        voiceIdPresent: Boolean(ctx.agent.voiceId?.trim()),
        ttsProviderUsed: null,
        intentDetected: userIntent,
        flowStep: 'instant_reply',
        responseDelayMs: totalTurnLatencyMs,
        openaiUsed: false,
      });
      return { reply, turnProof };
    }

    const callMemorySnapshot = await this.callMemory.load(callSessionId);
    const discussedForBypass =
      callMemorySnapshot.discussedProducts ?? callMemorySnapshot.mentionedProducts ?? [];
    const voiceTurnBypass = shouldBypassOpenAIForVoiceTurn({
      text: trimmedUserText,
      intent: userIntent,
      orderState: orderStateForInstant,
      spellingCaptureActive: isSpellingCaptureActive(sessionMetaEarly),
      checkoutLockActive: sessionMetaEarly.checkoutLockActive === true,
      transactionalCheckoutState:
        typeof sessionMetaEarly.transactionalCheckoutState === 'string'
          ? sessionMetaEarly.transactionalCheckoutState
          : null,
      hasDiscussedProduct: discussedForBypass.length > 0,
    });

    if (voiceTurnBypass.firewallBlock) {
      this.logger.warn(
        JSON.stringify({
          event: 'voice.intent.firewall.blocked_product_search',
          sessionId: callSessionId,
          tenantId: ctx.tenantId,
          agentId: ctx.agentId,
          ...voiceTurnBypass.firewallBlock,
        }),
      );
    }

    if (voiceTurnBypass.useConversationalSupport) {
      const storeName = ctx.store?.name ?? 'SureShot Books';
      reply = shortenVoiceReply(
        polishVoiceReply(buildConversationalSupportReply(trimmedUserText, userIntent, storeName), {
          maxSentences: 2,
          maxChars: 200,
        }),
        VOICE_WORD_LIMITS.simple + 10,
      );
      const userSeqSupport = await this.transcriptBuffer.getNextSequence(callSessionId);
      await this.transcriptBuffer.append(callSessionId, 'user', trimmedUserText, userSeqSupport);
      const agentSeqSupport = await this.transcriptBuffer.getNextSequence(callSessionId);
      await this.transcriptBuffer.append(callSessionId, 'agent', reply, agentSeqSupport);
      await this.callsService.mergeSessionMetadata(callSessionId, {
        ...buildLlmReplyMetadataPatch(reply),
        conversational_support_used: true,
        openaiCalled: false,
        shopifyCalled: false,
        lastIntentDetected: userIntent,
      });

      const totalTurnLatencyMs = Date.now() - turnStartedAt;
      this.voiceLatencyAnalyzer.recordBreakdown({
        callSessionId,
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        route: 'conversational_support',
        intentDetectionMs: intentLatencyMs,
        openaiMs: 0,
        totalCallerWaitMs: totalTurnLatencyMs,
        instantReplyUsed: false,
        openaiCalled: false,
        ttsGenerated: false,
        openaiSkippedReason: 'conversational_support',
      });

      logVoiceTurnPerformance({
        callSessionId,
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        totalTurnLatencyMs,
        intentLatencyMs,
        openaiLatencyMs: 0,
        instantReplyUsed: false,
        openaiCalled: false,
        cacheHit: false,
        slowPathReason: totalTurnLatencyMs >= 300 ? 'conversational_support_slow' : null,
      });

      this.logger.log(
        JSON.stringify({
          event: 'voice.brain.selected',
          agentId: ctx.agentId,
          sessionId: callSessionId,
          tenantId: ctx.tenantId,
          brain: 'conversational_support',
          openaiCalled: false,
          shopifyCalled: false,
          userIntent,
          langCode,
        }),
      );

      const turnProof = {
        callSessionId,
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        userSpeechText: safeText.slice(0, 500),
        openaiCalled: false,
        openaiSuccess: true,
        conversational_support_used: true,
        shopifyCalled: false,
        replyPreview: reply.slice(0, 240),
        flowStep: 'conversational_support',
        brain: 'conversational_support',
        totalTurnLatencyMs,
        intentLatencyMs,
      };
      return { reply, turnProof };
    }

    if (voiceTurnBypass.useProductFastPath) {
      const fastResult = await this.productFastPath.execute({
        callSessionId,
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        speechText: trimmedUserText,
        intent: userIntent,
        orderState: orderStateForInstant,
        sessionMeta: sessionMetaEarly,
      });

      if (fastResult.used && fastResult.reply) {
        reply = fastResult.reply;
        const userSeqFast = await this.transcriptBuffer.getNextSequence(callSessionId);
        await this.transcriptBuffer.append(callSessionId, 'user', trimmedUserText, userSeqFast);
        const agentSeqFast = await this.transcriptBuffer.getNextSequence(callSessionId);
        await this.transcriptBuffer.append(callSessionId, 'agent', reply, agentSeqFast);
        await this.callsService.mergeSessionMetadata(callSessionId, {
          ...buildLlmReplyMetadataPatch(reply),
          product_fast_path_used: true,
          openaiCalled: false,
          lastIntentDetected: userIntent,
          lastProductQuery: trimmedUserText.slice(0, 200),
        });

        const totalTurnLatencyMs = Date.now() - turnStartedAt;
        this.voiceLatencyAnalyzer.recordBreakdown({
          callSessionId,
          tenantId: ctx.tenantId,
          agentId: ctx.agentId,
          route: 'product_fast_path',
          intentDetectionMs: intentLatencyMs,
          openaiMs: 0,
          toolMs: 0,
          shopifyMs: fastResult.shopifySkipped ? 0 : fastResult.localProductSearchMs,
          totalCallerWaitMs: totalTurnLatencyMs,
          instantReplyUsed: false,
          openaiCalled: false,
          ttsGenerated: false,
          openaiSkippedReason: 'deterministic_product_fast_path',
        });

        logVoiceTurnPerformance({
          callSessionId,
          tenantId: ctx.tenantId,
          agentId: ctx.agentId,
          totalTurnLatencyMs,
          intentLatencyMs,
          openaiLatencyMs: 0,
          instantReplyUsed: false,
          openaiCalled: false,
          cacheHit: Boolean(fastResult.shopifySkipped),
          slowPathReason: null,
        });

        this.logger.log(
          JSON.stringify({
            event: 'voice.brain.selected',
            agentId: ctx.agentId,
            sessionId: callSessionId,
            tenantId: ctx.tenantId,
            brain: 'deterministic_product_fast_path',
            product_fast_path_used: true,
            openaiCalled: false,
            localProductSearchMs: fastResult.localProductSearchMs,
            shopifySkipped: fastResult.shopifySkipped,
            productFastPathConfidence: fastResult.productFastPathConfidence,
            userIntent,
          }),
        );

        const turnProof = {
          callSessionId,
          tenantId: ctx.tenantId,
          agentId: ctx.agentId,
          userSpeechText: safeText.slice(0, 500),
          openaiCalled: false,
          openaiSuccess: true,
          product_fast_path_used: true,
          instant_reply_used: false,
          replyPreview: reply.slice(0, 240),
          flowStep: 'product_fast_path',
          brain: 'deterministic_product_fast_path',
          totalTurnLatencyMs,
          intentLatencyMs,
          openaiLatencyMs: 0,
          localProductSearchMs: fastResult.localProductSearchMs,
          shopifySkipped: fastResult.shopifySkipped,
          productFastPathConfidence: fastResult.productFastPathConfidence,
        };
        return { reply, turnProof };
      }
    }

    const sessionRow = sessionRowEarly;
    const sessionMeta = sessionMetaEarly;

    let orchestratorSpeech = trimmedUserText;
    let rawTranscriptForLog = trimmedUserText;

    if (isSpellingCaptureActive(sessionMeta)) {
      const spellingPipeline = processTelephonySpellingPipeline(trimmedUserText, {
        retryCount: Number(sessionMeta.emailRetryCount ?? 0),
        forceSpellingMode: true,
      });
      orchestratorSpeech = spellingPipeline.orchestratorText;
      rawTranscriptForLog = spellingPipeline.rawSpeechTranscript;

      await this.callsService.mergeSessionMetadata(callSessionId, {
        rawSpeechTranscript: spellingPipeline.rawSpeechTranscript,
        normalizedConversationTranscript: spellingPipeline.normalizedConversationTranscript,
        normalizedSpellingTranscript: spellingPipeline.normalizedSpellingTranscript,
        lastRawTranscript: spellingPipeline.rawSpeechTranscript,
        lastNormalizedTranscript: spellingPipeline.normalizedSpellingTranscript,
        transcriptNormalizeSkipped: true,
        transcriptNormalizeSkipReason: 'spelling_capture_mode',
        ...spellingPipeline.logFields,
      });

      this.logger.log(
        JSON.stringify({
          event: 'voice.spelling.pipeline',
          callSessionId,
          tenantId: ctx.tenantId,
          agentId: ctx.agentId,
          ...spellingPipeline.logFields,
        }),
      );
    } else {
      const transcriptConfidence = sessionMeta.transcriptNormalizeConfidence;
      const skipNormalization = shouldSkipNormalizationForProductFastPath(
        trimmedUserText,
        typeof transcriptConfidence === 'number' || typeof transcriptConfidence === 'string'
          ? transcriptConfidence
          : null,
      );
      if (skipNormalization) {
        orchestratorSpeech = trimmedUserText;
        rawTranscriptForLog = trimmedUserText;
        await this.callsService.mergeSessionMetadata(callSessionId, {
          rawSpeechTranscript: trimmedUserText,
          normalizedConversationTranscript: trimmedUserText,
          lastRawTranscript: trimmedUserText,
          lastNormalizedTranscript: trimmedUserText,
          transcriptNormalizeSkipped: true,
          transcriptNormalizeSkipReason: 'product_fast_path_high_confidence',
        });
      } else {
        const normalization = await this.transcriptNormalizer.normalizeTranscript(trimmedUserText, {
          tenantId: ctx.tenantId,
          agentId: ctx.agentId,
          callSessionId,
          conversationHistory: historyFromDb,
        });
        orchestratorSpeech = normalization.normalized;
        rawTranscriptForLog = normalization.raw;

        await this.callsService.mergeSessionMetadata(callSessionId, {
          rawSpeechTranscript: normalization.raw,
          normalizedConversationTranscript: normalization.normalized,
          lastRawTranscript: normalization.raw,
          lastNormalizedTranscript: normalization.normalized,
          transcriptNormalizeConfidence: normalization.confidence,
          transcriptNormalizeCorrected: normalization.corrected,
        });
      }
    }

    const userSeq = await this.transcriptBuffer.getNextSequence(callSessionId);
    await this.transcriptBuffer.append(callSessionId, 'user', orchestratorSpeech, userSeq);

    this.logger.log(
      JSON.stringify({
        event: 'voice.brain.selected',
        agentId: ctx.agentId,
        sessionId: callSessionId,
        tenantId: ctx.tenantId,
        userText: orchestratorSpeech.slice(0, 500),
        rawTranscript: rawTranscriptForLog.slice(0, 500),
        spellingCaptureMode: isSpellingCaptureActive(sessionMeta),
        brain: 'openai_llm_agent_orchestrator',
      }),
    );

    const llmStartedAt = Date.now();
    if (userIntent === 'product_search' && orderStateForInstant === 'IDLE') {
      this.logger.error(
        JSON.stringify({
          event: 'CRITICAL_OPENAI_USED_ON_PRODUCT_FAST_PATH',
          callSessionId,
          tenantId: ctx.tenantId,
          agentId: ctx.agentId,
          userSpeechText: orchestratorSpeech.slice(0, 200),
          intent: userIntent,
        }),
      );
    }
    const result = await this.llmAgent.handleTurn(callSessionId, orchestratorSpeech, historyFromDb);
    openaiLatencyMs = Date.now() - llmStartedAt;
    const responseDelayMs = openaiLatencyMs;

    if (result.toolCallsCount > 0) {
      await this.conversationAnalytics.recordToolLatency(
        ctx.tenantId,
        callSessionId,
        responseDelayMs,
        'voice_tool_loop',
      );
    }

    reply = result.reply;
    if (result.error?.code === 'OPENAI_429' || result.error?.code === 'OPENAI_ERROR' || result.error?.code === 'NO_KEY') {
      reply =
        ctx.agent.fallbackMessage ??
        "I'm having a brief issue reaching our system. What book title or topic can I help you find?";
      await this.callEvents.log(ctx.tenantId, callSessionId, CallEventType.FALLBACK_USED, {
        reason: result.error?.code ?? 'openai_error',
        brainBypass: true,
      });
    }

    const agentSeq = await this.transcriptBuffer.getNextSequence(callSessionId);
    await this.transcriptBuffer.append(callSessionId, 'agent', reply, agentSeq);
    await this.callsService.mergeSessionMetadata(callSessionId, buildLlmReplyMetadataPatch(reply));

    if (result.escalated) {
      await this.callsService.updateSessionStatus(callSessionId, {
        escalated: true,
        lastEventAt: new Date(),
        metadata: { endedReason: 'escalated' } as Record<string, unknown>,
      });
      await this.callEvents.log(ctx.tenantId, callSessionId, CallEventType.ESCALATION_TRIGGERED);
    }

    this.logger.log(
      JSON.stringify({
        event: 'voice.brain.final_reply',
        agentId: ctx.agentId,
        sessionId: callSessionId,
        replyPreview: reply.slice(0, 240),
        toolCallsUsed: result.toolNames,
        intent: result.state.customerIntent ?? null,
        stateStage: result.state.checkoutStage,
        transactionalCheckoutState: result.state.transactionalCheckoutState ?? result.proof?.transactionalCheckoutState ?? null,
        transactionalMode: result.proof?.transactionalMode ?? false,
        skipOpenAiGeneration: result.proof?.skipOpenAiGeneration ?? false,
        deterministicReplyUsed: result.proof?.deterministicReplyUsed ?? false,
        latencyMs: responseDelayMs,
      }),
    );

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
      ttsProviderUsed: null as string | null,
      flowStep: result.proof?.skipOpenAiGeneration
        ? 'transactional_checkout'
        : result.toolCallsCount > 0
          ? 'llm_agent_tool_loop'
          : 'llm_agent_reply',
      brain: result.proof?.skipOpenAiGeneration
        ? 'transactional_checkout_orchestrator'
        : 'openai_llm_agent_orchestrator',
      llmTools: result.toolNames,
      openaiUsed: result.proof?.openaiCalled ?? true,
      transactionalMode: result.proof?.transactionalMode ?? false,
        transactionalCheckoutState: result.proof?.transactionalCheckoutState ?? null,
        CHECKOUT_LOCK_ACTIVE: result.proof?.transactionalMode === true,
        deterministicReplyUsed: result.proof?.deterministicReplyUsed ?? false,
      skipOpenAiGeneration: result.proof?.skipOpenAiGeneration ?? false,
    };
    this.logTurnProof(turnProof);

    const totalTurnLatencyMs = Date.now() - turnStartedAt;
    const slowPathReason =
      totalTurnLatencyMs >= 2000
        ? result.toolNames.some((n) => /search|shopify/i.test(n))
          ? 'shopify_tools'
          : result.proof?.openaiCalled
            ? 'openai'
            : 'llm_pipeline'
        : null;

    logVoiceTurnPerformance({
      callSessionId,
      tenantId: ctx.tenantId,
      agentId: ctx.agentId,
      totalTurnLatencyMs,
      intentLatencyMs,
      openaiLatencyMs: result.proof?.openaiCalled ? openaiLatencyMs : 0,
      instantReplyUsed: false,
      openaiCalled: result.proof?.openaiCalled ?? true,
      cacheHit: false,
      slowPathReason,
    });

    return {
      reply,
      turnProof: {
        ...turnProof,
        totalTurnLatencyMs,
        intentLatencyMs,
        openaiLatencyMs: result.proof?.openaiCalled ? openaiLatencyMs : 0,
        instantReplyUsed: false,
      },
    };
  }

  private logTurnProof(p: {
    callSessionId: string;
    tenantId: string | null;
    agentId: string | null;
    userSpeechText: string;
    openaiKeySource: string;
    modelUsed: string;
    openaiCalled: boolean;
    openaiSuccess: boolean;
    replyPreview: string;
    voiceProvider: string | null;
    voiceIdPresent: boolean;
    ttsProviderUsed: string | null;
    intentDetected?: UserUtteranceIntent;
    toolCalled?: boolean;
    flowStep?: string;
    state?: string;
    finalResponseText?: string;
    responseSource?: 'template' | 'openai';
    responseTemplateUsed?: string;
    responseMode?: 'template' | 'openai';
    templateUsed?: string;
    contextAware?: boolean;
    questionAnsweredFirst?: boolean;
    interruptionHandled?: boolean;
    conversationTone?: ConversationTone;
    toneLeadUsed?: string | null;
    paymentSuggestionUsed?: boolean;
    followUpTriggered?: boolean;
    responseDelayMs?: number | null;
    fillerUsed?: boolean;
    openaiUsed?: boolean;
    templateSuppressedBecauseRepeated?: boolean;
    customerIntentHandled?: boolean;
    toolCallAllowed?: boolean;
    toolCallBlockedReason?: string | null;
    customerQuestionType?: string;
  }): void {
    this.logger.log(
      JSON.stringify({
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
      }),
    );
  }
}
