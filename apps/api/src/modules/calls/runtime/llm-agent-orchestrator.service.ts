import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { SessionContextService, type VoiceSessionContext } from './session-context.service';
import { ToolOrchestratorService, type ToolResult } from './tool-orchestrator.service';
import { CallMemoryService } from './call-memory.service';
import { CallsService } from '../calls.service';
import { buildLlmAgentSystemPrompt } from './llm-agent-system-prompt';
import {
  LLM_AGENT_TOOLS,
  LLM_TOOL_TO_INTERNAL,
  mapLlmToolArgs,
  validateLlmAgentToolSchemas,
  type LlmAgentToolName,
} from './llm-agent-tools';
import {
  LLM_AGENT_STATE_KEY,
  applyToolResultToState,
  inferIntentHintFromText,
  mergeCallerSignalsIntoState,
  parseLlmAgentState,
  type LlmAgentConversationState,
} from './llm-agent-conversation-state.util';
import { normalizeOpenAiChatCompletionsModel } from '../../integrations/openai/voice-tool-schema.util';
import {
  BRAIN_REWRITE_USER_PROMPT,
  finalizeBrainReply,
} from './voice-brain-reply.util';
import { classifyOrderTurn } from './order-intent-classifier.util';
import {
  buildDisposableEmailRejectPrompt,
  buildEmailCollectionPrompt,
  buildEmailConfirmationPrompt,
  buildInvalidEmailRetryPrompt,
  buildMxRejectPrompt,
  buildPaymentEmailFallbackDeliveryPrompt,
  buildTypoCorrectionPrompt,
  buildCheckoutJourneyLog,
  buildVoiceEmailCaptureLog,
  isDeterministicTransactionalReply,
  isEmailConfirmationAffirmative,
  isEmailConfirmationNegative,
  isFallbackChannelAffirmative,
  maskEmailForLog,
  maskRawSpeechForLog,
  MAX_EMAIL_SEND_RETRIES,
  nextEmailRetryCount,
  shouldOfferEmailRetry,
  validateVoiceEmail,
  extractEmailFromSpeech,
  PRODUCT_CHECKOUT_INTRODUCED_KEY,
  parsePaymentEmailDeliveryFromToolData,
  isPaymentEmailDeliveryConfirmed,
  isPostPaymentClosingUtterance,
  POST_PAYMENT_THANK_YOU_REPLY,
  sanitizePaymentSuccessClaim,
  containsInlineEmailConfirmation,
  isCallerAskingEmailSpellback,
  spellEmailForCaller,
  type PaymentEmailDeliveryResult,
} from './voice-email-capture.util';
import {
  assertEmailConfirmedBeforeCheckout,
  buildEnterpriseCheckoutLog,
} from './enterprise-checkout-state-machine.util';
import {
  buildLanguageDetectedLog,
  detectCustomerLanguage,
  sessionLanguagePatch,
  setSessionLanguage,
  type CustomerLanguage,
  SESSION_LANGUAGE_KEY,
} from './voice-checkout-language.util';
import {
  buildEnterpriseEmailValidationLog,
  validateEnterpriseEmail,
} from './voice-email-enterprise-validation.util';
import { shouldBlockCheckoutForOutOfStock } from './voice-stock-sales-policy.util';
import {
  applyPaymentFlowToState,
  buildConfirmedEmailCheckoutReply,
  buildCreatePaymentLinkArgsFromState,
  shouldTriggerCheckoutAfterEmailConfirmed,
} from './llm-agent-auto-checkout.util';
import {
  applyCheckoutSignalsFromSpeech,
  applyDeterministicProductSelection,
  assertNoOpenAiDuringTransactionalCheckout,
  buildTransactionalCheckoutLog,
  CHECKOUT_LOCK_ACTIVE_KEY,
  emergencyBlockLlmCheckoutReply,
  evaluateCheckoutLock,
  guardTransactionalReply,
  hasSelectedInStockProduct,
  isCheckoutLockedUtterance,
  isTransactionalCheckoutActive,
  normalizeEmailConfirmationState,
  resolveTransactionalCheckoutState,
  routeTransactionalCheckoutTurn,
  TRANSACTIONAL_CHECKOUT_STATE_KEY,
  type TransactionalCheckoutState,
} from './transactional-checkout-state.util';
import {
  voiceFastModeMaxToolIterations,
  voiceFastModeParallelToolCalls,
  voiceLlmMaxTokens,
} from './voice-commerce-fast-mode.util';

const MAX_TOOL_ITERATIONS = voiceFastModeMaxToolIterations(Number(process.env.MAX_TOOL_ITERATIONS_VOICE) || 8);
const MAX_TOOL_CALLS_PER_TURN = Number(process.env.MAX_TOOL_CALLS_PER_TURN) || 4;
const VOICE_COMMERCE_TEMPERATURE_DEFAULT = Number(process.env.VOICE_COMMERCE_TEMPERATURE_DEFAULT) || 0.35;
const VOICE_COMMERCE_TEMPERATURE_CAP = Number(process.env.VOICE_COMMERCE_TEMPERATURE_CAP) || 0.45;

export type LlmAgentTurnResult = {
  reply: string;
  toolCallsCount: number;
  toolNames: string[];
  escalated?: boolean;
  state: LlmAgentConversationState;
  error?: { code: 'OPENAI_429' | 'OPENAI_401' | 'OPENAI_ERROR' | 'NO_KEY'; message?: string };
  proof?: {
    openaiKeySource: string;
    modelUsed: string;
    openaiCalled: boolean;
    openaiSuccess: boolean;
    transactionalMode?: boolean;
    transactionalCheckoutState?: TransactionalCheckoutState;
    deterministicMode?: boolean;
    deterministicReplyUsed?: boolean;
    skipOpenAiGeneration?: boolean;
  };
};

export type OpenAiCompletionFn = (
  params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
) => Promise<OpenAI.Chat.ChatCompletion>;

@Injectable()
export class LlmAgentOrchestratorService implements OnModuleInit {
  private readonly logger = new Logger(LlmAgentOrchestratorService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly sessionContext: SessionContextService,
    private readonly toolOrchestrator: ToolOrchestratorService,
    private readonly callMemory: CallMemoryService,
    private readonly callsService: CallsService,
  ) {}

  onModuleInit(): void {
    validateLlmAgentToolSchemas();
  }

  /** Primary entry: OpenAI is the only conversation brain after inbound greeting. */
  async handleTurn(
    callSessionId: string,
    userMessage: string,
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
    options?: { completionFn?: OpenAiCompletionFn; skipMxValidation?: boolean },
  ): Promise<LlmAgentTurnResult> {
    return this.processTurn(callSessionId, userMessage, conversationHistory, options);
  }

  async processTurn(
    callSessionId: string,
    userMessage: string,
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
    options?: { completionFn?: OpenAiCompletionFn; skipMxValidation?: boolean },
  ): Promise<LlmAgentTurnResult> {
    const ctx = await this.sessionContext.load(callSessionId);
    if (!ctx) {
      return {
        reply: "I'm sorry, I lost context on this call. Please try again.",
        toolCallsCount: 0,
        toolNames: [],
        state: parseLlmAgentState(null),
        error: { code: 'NO_KEY', message: 'session_missing' },
      };
    }

    const apiKey = ctx.agent.openaiApiKey?.trim() ?? '';
    const openaiKeySource = ctx.agent.runtimeCredentialHints?.openaiKeySource ?? 'none';
    if (!apiKey) {
      return {
        reply:
          ctx.agent.fallbackMessage ?? "I'm having trouble connecting right now. Please call back shortly.",
        toolCallsCount: 0,
        toolNames: [],
        state: await this.loadState(callSessionId),
        error: { code: 'NO_KEY', message: 'openai_key_missing' },
        proof: {
          openaiKeySource,
          modelUsed: 'n/a',
          openaiCalled: false,
          openaiSuccess: false,
        },
      };
    }

    let state = await this.loadState(callSessionId);

    const loadSessionMeta = async (): Promise<Record<string, unknown>> => {
      const sessionRow = await this.callsService.findOneById(callSessionId);
      return sessionRow.metadata &&
        typeof sessionRow.metadata === 'object' &&
        !Array.isArray(sessionRow.metadata)
        ? (sessionRow.metadata as Record<string, unknown>)
        : {};
    };

    const memory = await this.callMemory.load(callSessionId);
    const sessionMetaAtStart = await loadSessionMeta();

    const langDetection = detectCustomerLanguage(userMessage);
    const priorLanguage = sessionMetaAtStart[SESSION_LANGUAGE_KEY] as CustomerLanguage | undefined;
    const customerLanguage = setSessionLanguage(
      priorLanguage,
      langDetection.customerLanguage,
      langDetection.confidence,
    );
    if (!priorLanguage || priorLanguage !== customerLanguage) {
      await this.callsService.mergeSessionMetadata(callSessionId, sessionLanguagePatch(customerLanguage));
      this.logger.log(
        JSON.stringify(
          buildLanguageDetectedLog({
            callSessionId,
            language: customerLanguage,
            confidence: langDetection.confidence,
          }),
        ),
      );
    }

    const paymentLinkSent =
      state.paymentLinkSent === true || sessionMetaAtStart.orderState === 'PAYMENT_LINK_SENT';

    if (paymentLinkSent && isPostPaymentClosingUtterance(userMessage)) {
      this.logger.log(
        JSON.stringify({
          event: 'voice.checkout.post_payment_closing',
          callSessionId,
          tenantId: ctx.tenantId,
          agentId: ctx.agentId,
        }),
      );
      return {
        reply: POST_PAYMENT_THANK_YOU_REPLY,
        toolCallsCount: 0,
        toolNames: [],
        escalated: false,
        state,
        proof: {
          openaiKeySource,
          modelUsed: 'n/a',
          openaiCalled: false,
          openaiSuccess: true,
          transactionalMode: false,
          deterministicReplyUsed: true,
          skipOpenAiGeneration: true,
        },
      };
    }

    /** PRIORITY 1: checkout signals before intent classification or OpenAI. */
    state = applyCheckoutSignalsFromSpeech(state, userMessage);

    if (paymentLinkSent && extractEmailFromSpeech(userMessage)) {
      return {
        reply: POST_PAYMENT_THANK_YOU_REPLY,
        toolCallsCount: 0,
        toolNames: [],
        escalated: false,
        state,
        proof: {
          openaiKeySource,
          modelUsed: 'n/a',
          openaiCalled: false,
          openaiSuccess: true,
          deterministicMode: false,
          deterministicReplyUsed: true,
          skipOpenAiGeneration: true,
        },
      };
    }

    let emailConfirmedThisTurn = false;
    let emailCapturedReply: string | null = null;
    let skipBrainRewrite = false;
    let deterministicReplyUsed = false;
    let deliveryConfirmedThisTurn = false;
    let checkoutLockActive = false;
    let transactionalCheckoutMode = false;

    const loadEmailRetryCount = async (): Promise<number> => {
      const sessionMeta = await loadSessionMeta();
      return Number(sessionMeta.emailRetryCount ?? 0);
    };

    const pendingEmailForConfirm =
      memory.collectedEmail?.trim() ||
      (typeof sessionMetaAtStart.normalizedEmail === 'string'
        ? sessionMetaAtStart.normalizedEmail.trim()
        : '');
    const awaitingEmailConfirmation =
      (memory.emailConfirmationState === 'pending' ||
        sessionMetaAtStart.emailConfirmationState === 'pending') &&
      pendingEmailForConfirm.length > 0;

    const emailInUtteranceWhileConfirming =
      awaitingEmailConfirmation ? extractEmailFromSpeech(userMessage) : null;

    if (isEmailConfirmationNegative(userMessage)) {
      const correctionEmail = extractEmailFromSpeech(userMessage);
      const nextRetry = nextEmailRetryCount(await loadEmailRetryCount(), false);

      this.logger.log(
        JSON.stringify(
          buildEnterpriseCheckoutLog('negative_confirmation_detected', {
            callSessionId,
            tenantId: ctx.tenantId,
            agentId: ctx.agentId,
            hasCorrectionEmail: Boolean(correctionEmail),
          }),
        ),
      );
      this.logger.log(
        JSON.stringify(
          buildEnterpriseCheckoutLog('email_confirmation_rejected', {
            callSessionId,
            tenantId: ctx.tenantId,
            agentId: ctx.agentId,
            maskedEmail: pendingEmailForConfirm ? maskEmailForLog(pendingEmailForConfirm) : undefined,
          }),
        ),
      );

      await this.callMemory.setEmailState(callSessionId, '', 'pending');
      state = mergeCallerSignalsIntoState(state, { email: '' });

      if (correctionEmail) {
        this.logger.log(
          JSON.stringify(
            buildEnterpriseCheckoutLog('email_recollection_started', {
              callSessionId,
              tenantId: ctx.tenantId,
              agentId: ctx.agentId,
            }),
          ),
        );
        const enterprise = await validateEnterpriseEmail(correctionEmail, {
          skipMx: options?.skipMxValidation === true,
        });
        if (enterprise.valid) {
          state = mergeCallerSignalsIntoState(state, { email: enterprise.normalized });
          await this.callMemory.setEmailState(callSessionId, enterprise.normalized, 'pending');
          await this.callsService.mergeSessionMetadata(callSessionId, {
            orderState: 'EMAIL_CONFIRMING',
            normalizedEmail: enterprise.normalized,
            emailConfirmationState: 'pending',
            emailEnterpriseValidated: true,
            emailRetryCount: nextRetry,
            pendingTypoCorrection: null,
            [TRANSACTIONAL_CHECKOUT_STATE_KEY]: 'EMAIL_CONFIRMATION_REQUIRED',
          });
          emailCapturedReply = buildEmailConfirmationPrompt(
            enterprise.normalized,
            customerLanguage,
          );
        } else {
          await this.callsService.mergeSessionMetadata(callSessionId, {
            orderState: 'EMAIL_COLLECTING',
            normalizedEmail: '',
            emailConfirmationState: 'rejected',
            emailRetryCount: nextRetry,
          });
          emailCapturedReply = buildInvalidEmailRetryPrompt(nextRetry, customerLanguage);
        }
      } else {
        await this.callsService.mergeSessionMetadata(callSessionId, {
          orderState: 'EMAIL_COLLECTING',
          normalizedEmail: '',
          emailConfirmationState: 'rejected',
          emailRetryCount: nextRetry,
          [TRANSACTIONAL_CHECKOUT_STATE_KEY]: 'EMAIL_COLLECTION_REQUIRED',
        });
        emailCapturedReply = shouldOfferEmailRetry(nextRetry)
          ? buildInvalidEmailRetryPrompt(nextRetry, customerLanguage)
          : buildEmailCollectionPrompt(nextRetry, false, customerLanguage);
      }

      skipBrainRewrite = true;
      deterministicReplyUsed = true;
      this.logger.log(
        JSON.stringify(
          buildVoiceEmailCaptureLog({
            event: 'voice.email.rejected',
            callSessionId,
            tenantId: ctx.tenantId,
            agentId: ctx.agentId,
            confirmationStatus: 'rejected',
            retryCount: nextRetry,
          }),
        ),
      );
    } else if (containsInlineEmailConfirmation(userMessage)) {
      const inlineEmail = extractEmailFromSpeech(userMessage);
      if (inlineEmail) {
        const enterprise = await validateEnterpriseEmail(inlineEmail, {
          skipMx: options?.skipMxValidation === true,
        });
        if (enterprise.valid) {
          state = mergeCallerSignalsIntoState(state, { email: enterprise.normalized });
          await this.callMemory.setEmailState(callSessionId, enterprise.normalized, 'confirmed');
          await this.callsService.mergeSessionMetadata(callSessionId, {
            orderState: 'EMAIL_CONFIRMED',
            normalizedEmail: enterprise.normalized,
            emailConfirmationState: 'confirmed',
            emailEnterpriseValidated: true,
            [TRANSACTIONAL_CHECKOUT_STATE_KEY]: 'EMAIL_CONFIRMED',
          });
          emailConfirmedThisTurn = true;
          skipBrainRewrite = true;
          this.logger.log(
            JSON.stringify(
              buildEnterpriseCheckoutLog('email_inline_confirmation_detected', {
                callSessionId,
                tenantId: ctx.tenantId,
                agentId: ctx.agentId,
                maskedEmail: maskEmailForLog(enterprise.normalized),
              }),
            ),
          );
        }
      }
    } else if (isCallerAskingEmailSpellback(userMessage) && pendingEmailForConfirm) {
      emailCapturedReply = spellEmailForCaller(pendingEmailForConfirm);
      skipBrainRewrite = true;
      deterministicReplyUsed = true;
    } else if (
      awaitingEmailConfirmation &&
      !emailInUtteranceWhileConfirming &&
      isEmailConfirmationAffirmative(userMessage)
    ) {
      const confirmedEmail = pendingEmailForConfirm;
      await this.callMemory.setEmailState(callSessionId, confirmedEmail, 'confirmed');
      await this.callsService.mergeSessionMetadata(callSessionId, {
        orderState: 'EMAIL_CONFIRMED',
        normalizedEmail: confirmedEmail,
        emailConfirmationState: 'confirmed',
        [TRANSACTIONAL_CHECKOUT_STATE_KEY]: 'EMAIL_CONFIRMED',
      });
      state = mergeCallerSignalsIntoState(state, { email: confirmedEmail });
      emailConfirmedThisTurn = true;
      this.logger.log(
        JSON.stringify(
          buildCheckoutJourneyLog('customer_confirmed_email', {
            callSessionId,
            tenantId: ctx.tenantId,
            agentId: ctx.agentId,
            maskedEmail: maskEmailForLog(confirmedEmail),
          }),
        ),
      );
      this.logger.log(
        JSON.stringify(
          buildVoiceEmailCaptureLog({
            event: 'voice.email.confirmed',
            callSessionId,
            tenantId: ctx.tenantId,
            agentId: ctx.agentId,
            maskedEmail: maskEmailForLog(confirmedEmail),
            confirmationStatus: 'confirmed',
          }),
        ),
      );
      skipBrainRewrite = true;
    } else if (
      sessionMetaAtStart.pendingTypoCorrection &&
      typeof sessionMetaAtStart.pendingTypoCorrection === 'object' &&
      sessionMetaAtStart.pendingTypoCorrection !== null &&
      isEmailConfirmationAffirmative(userMessage)
    ) {
      const typo = sessionMetaAtStart.pendingTypoCorrection as {
        correctedEmail?: string;
        originalEmail?: string;
      };
      const corrected = typo.correctedEmail?.trim();
      if (corrected && validateVoiceEmail(corrected).valid) {
        const enterprise = await validateEnterpriseEmail(corrected, {
          skipMx: options?.skipMxValidation === true,
        });
        if (enterprise.valid) {
          state = mergeCallerSignalsIntoState(state, { email: enterprise.normalized });
          await this.callMemory.setEmailState(callSessionId, enterprise.normalized, 'pending');
          await this.callsService.mergeSessionMetadata(callSessionId, {
            orderState: 'EMAIL_CONFIRMING',
            normalizedEmail: enterprise.normalized,
            emailConfirmationState: 'pending',
            emailEnterpriseValidated: true,
            pendingTypoCorrection: null,
            [TRANSACTIONAL_CHECKOUT_STATE_KEY]: 'EMAIL_CONFIRMATION_REQUIRED',
          });
          emailCapturedReply = buildEmailConfirmationPrompt(enterprise.normalized);
          skipBrainRewrite = true;
        }
      }
    } else {
      const spokenEmail = extractEmailFromSpeech(userMessage);
      if (spokenEmail) {
        const emailRetryCount = await loadEmailRetryCount();
        const validation = validateVoiceEmail(spokenEmail);
        const enterprise = await validateEnterpriseEmail(spokenEmail, {
          skipMx: options?.skipMxValidation === true,
        });
        this.logger.log(
          JSON.stringify(
            buildCheckoutJourneyLog('email_captured', {
              callSessionId,
              tenantId: ctx.tenantId,
              agentId: ctx.agentId,
              maskedEmail: maskEmailForLog(enterprise.normalized),
            }),
          ),
        );
        this.logger.log(
          JSON.stringify(
            buildVoiceEmailCaptureLog({
              event: 'voice.email.captured',
              callSessionId,
              tenantId: ctx.tenantId,
              agentId: ctx.agentId,
              rawPreview: maskRawSpeechForLog(spokenEmail),
              normalizedPreview: enterprise.normalized,
              maskedEmail: maskEmailForLog(enterprise.normalized),
              valid: enterprise.valid,
              retryCount: emailRetryCount,
            }),
          ),
        );
        this.logger.log(
          JSON.stringify(
            buildEnterpriseEmailValidationLog({
              callSessionId,
              tenantId: ctx.tenantId,
              agentId: ctx.agentId,
              maskedEmail: maskEmailForLog(enterprise.normalized),
              regexValid: enterprise.regexValid,
              disposable: enterprise.disposable,
              mxValid: enterprise.mxValid,
              mxChecked: enterprise.mxChecked,
              typoFromDomain: enterprise.typoSuggestion?.fromDomain,
              typoToDomain: enterprise.typoSuggestion?.toDomain,
              valid: enterprise.valid,
              blockedReason: enterprise.blockedReason,
            }),
          ),
        );

        if (enterprise.typoSuggestion) {
          await this.callsService.mergeSessionMetadata(callSessionId, {
            orderState: 'EMAIL_COLLECTING',
            pendingTypoCorrection: {
              correctedEmail: enterprise.typoSuggestion.correctedEmail,
              originalEmail: enterprise.normalized,
            },
            [TRANSACTIONAL_CHECKOUT_STATE_KEY]: 'EMAIL_CAPTURED',
          });
          emailCapturedReply = buildTypoCorrectionPrompt(
            enterprise.typoSuggestion.correctedEmail,
            enterprise.normalized,
          );
          skipBrainRewrite = true;
          this.logger.log(
            JSON.stringify(
              buildVoiceEmailCaptureLog({
                event: 'voice.email.typo_suggested',
                callSessionId,
                tenantId: ctx.tenantId,
                agentId: ctx.agentId,
                maskedEmail: maskEmailForLog(enterprise.typoSuggestion.correctedEmail),
              }),
            ),
          );
        } else if (enterprise.disposable) {
          const retryCount = nextEmailRetryCount(emailRetryCount, false);
          await this.callsService.mergeSessionMetadata(callSessionId, {
            orderState: 'EMAIL_COLLECTING',
            emailRetryCount: retryCount,
          });
          emailCapturedReply = buildDisposableEmailRejectPrompt();
          skipBrainRewrite = true;
        } else if (enterprise.blockedReason === 'mx_missing') {
          const retryCount = nextEmailRetryCount(emailRetryCount, false);
          await this.callsService.mergeSessionMetadata(callSessionId, {
            orderState: 'EMAIL_COLLECTING',
            emailRetryCount: retryCount,
          });
          emailCapturedReply = buildMxRejectPrompt();
          skipBrainRewrite = true;
        } else if (enterprise.valid) {
          state = mergeCallerSignalsIntoState(state, { email: enterprise.normalized });
          await this.callMemory.setEmailState(callSessionId, enterprise.normalized, 'pending');
          await this.callsService.mergeSessionMetadata(callSessionId, {
            orderState: 'EMAIL_CONFIRMING',
            normalizedEmail: enterprise.normalized,
            emailConfirmationState: 'pending',
            emailEnterpriseValidated: true,
            pendingTypoCorrection: null,
            [TRANSACTIONAL_CHECKOUT_STATE_KEY]: 'EMAIL_CONFIRMATION_REQUIRED',
          });
          emailCapturedReply = buildEmailConfirmationPrompt(
            enterprise.normalized,
            customerLanguage,
          );
          skipBrainRewrite = true;
          this.logger.log(
            JSON.stringify(
              buildCheckoutJourneyLog('email_validation_passed', {
                callSessionId,
                tenantId: ctx.tenantId,
                agentId: ctx.agentId,
                maskedEmail: maskEmailForLog(enterprise.normalized),
              }),
            ),
          );
          this.logger.log(
            JSON.stringify(
              buildCheckoutJourneyLog('email_confirmation_required', {
                callSessionId,
                tenantId: ctx.tenantId,
                agentId: ctx.agentId,
                maskedEmail: maskEmailForLog(enterprise.normalized),
              }),
            ),
          );
          this.logger.log(
            JSON.stringify(
              buildVoiceEmailCaptureLog({
                event: 'voice.email.validated',
                callSessionId,
                tenantId: ctx.tenantId,
                agentId: ctx.agentId,
                maskedEmail: maskEmailForLog(enterprise.normalized),
                valid: true,
              }),
            ),
          );
        } else {
          const retryCount = nextEmailRetryCount(emailRetryCount, false);
          await this.callsService.mergeSessionMetadata(callSessionId, {
            orderState: 'EMAIL_COLLECTING',
            emailRetryCount: retryCount,
            emailConfirmationState: 'pending',
          });
          emailCapturedReply = buildInvalidEmailRetryPrompt(retryCount, customerLanguage);
          skipBrainRewrite = true;
          this.logger.log(
            JSON.stringify(
              buildVoiceEmailCaptureLog({
                event: 'voice.email.validated',
                callSessionId,
                tenantId: ctx.tenantId,
                agentId: ctx.agentId,
                rawPreview: maskRawSpeechForLog(spokenEmail),
                normalizedPreview: validation.normalized,
                valid: false,
                retryCount,
              }),
            ),
          );
        }
      } else if (
        sessionMetaAtStart.emailSendFailureCount != null &&
        Number(sessionMetaAtStart.emailSendFailureCount) >= MAX_EMAIL_SEND_RETRIES
      ) {
        const fallback = isFallbackChannelAffirmative(userMessage);
        if (fallback) {
          await this.callsService.mergeSessionMetadata(callSessionId, {
            paymentLinkFallbackChannel: fallback,
          });
          emailCapturedReply =
            fallback === 'whatsapp'
              ? 'Understood. I will send your secure payment link on WhatsApp shortly.'
              : 'Understood. I will text your secure payment link by SMS shortly.';
          skipBrainRewrite = true;
          this.logger.log(
            JSON.stringify(
              buildVoiceEmailCaptureLog({
                event: 'voice.email.fallback_offered',
                callSessionId,
                tenantId: ctx.tenantId,
                agentId: ctx.agentId,
                fallbackChannel: fallback,
              }),
            ),
          );
        }
      }
    }

    const productCheckoutIntroduced =
      sessionMetaAtStart[PRODUCT_CHECKOUT_INTRODUCED_KEY] === true ||
      sessionMetaAtStart.productCheckoutIntroduced === true;

    const checkoutLock = evaluateCheckoutLock(state, {
      awaitingEmailConfirmation,
      emailCapturedThisTurn: emailCapturedReply != null,
      emailConfirmedThisTurn,
      emailRetryCount: Number(sessionMetaAtStart.emailRetryCount ?? 0),
      productCheckoutIntroduced,
      customerLanguage,
    });
    checkoutLockActive = checkoutLock.checkoutLockActive;
    transactionalCheckoutMode = checkoutLock.transactionalCheckoutMode;

    if (
      checkoutLockActive &&
      !emailCapturedReply &&
      !emailConfirmedThisTurn &&
      checkoutLock.reply
    ) {
      const lockCheckoutState = checkoutLock.checkoutState;
      const introducingProduct = lockCheckoutState === 'PRODUCT_CONFIRMED';
      const emailCollectionLocked = lockCheckoutState === 'EMAIL_COLLECTION_REQUIRED';
      state = {
        ...state,
        checkoutStage: introducingProduct ? 'product_selected' : 'email',
        customerIntent: introducingProduct ? 'checkout_confirmation' : 'email_collection',
        transactionalCheckoutState: lockCheckoutState,
        ...(introducingProduct || emailCollectionLocked
          ? { checkoutProductAcknowledged: true }
          : {}),
      };
      await this.persistState(callSessionId, state);
      await this.callsService.mergeSessionMetadata(callSessionId, {
        lastUserIntent: introducingProduct ? 'checkout_confirmation' : 'email_collection',
        [LLM_AGENT_STATE_KEY]: state,
        [TRANSACTIONAL_CHECKOUT_STATE_KEY]: lockCheckoutState,
        [CHECKOUT_LOCK_ACTIVE_KEY]: true,
        orderState: introducingProduct ? 'PRODUCT_CONFIRMED' : 'EMAIL_COLLECTING',
        ...((introducingProduct || emailCollectionLocked)
          ? { [PRODUCT_CHECKOUT_INTRODUCED_KEY]: true }
          : {}),
      });

      const finalReply = checkoutLock.reply;
      deterministicReplyUsed = true;

      if (lockCheckoutState === 'EMAIL_COLLECTION_REQUIRED') {
        this.logger.log(
          JSON.stringify(
            buildCheckoutJourneyLog('email_collection_prompt_sent', {
              callSessionId,
              tenantId: ctx.tenantId,
              agentId: ctx.agentId,
            }),
          ),
        );
      }

      this.logger.log(
        JSON.stringify(
          buildTransactionalCheckoutLog({
            callSessionId,
            tenantId: ctx.tenantId,
            agentId: ctx.agentId,
            transactionalMode: true,
            transactionalCheckoutMode: true,
            checkoutState: lockCheckoutState,
            deterministicReplyUsed: true,
            skipOpenAiGeneration: true,
            activeProductSelected: checkoutLock.activeProductSelected,
            quantityConfirmed: checkoutLock.quantityConfirmed,
            llmCheckoutStage: state.checkoutStage,
          }),
        ),
      );

      this.logger.log(
        JSON.stringify({
          event: 'voice.checkout_lock.proof',
          CHECKOUT_LOCK_ACTIVE: true,
          callSessionId,
          tenantId: ctx.tenantId,
          agentId: ctx.agentId,
          activeProductSelected: checkoutLock.activeProductSelected,
          quantityConfirmed: checkoutLock.quantityConfirmed,
          openaiCalled: false,
        }),
      );

      this.logger.log(
        JSON.stringify({
          event: 'voice.brain.final_reply',
          agentId: ctx.agentId,
          sessionId: callSessionId,
          replyPreview: finalReply.slice(0, 240),
          toolCallsUsed: [],
          intent: 'email_collection',
          stateStage: state.checkoutStage,
          transactionalCheckoutState: lockCheckoutState,
          transactionalMode: true,
          skipOpenAiGeneration: true,
          deterministicReplyUsed: true,
          CHECKOUT_LOCK_ACTIVE: true,
        }),
      );

      assertNoOpenAiDuringTransactionalCheckout({
        transactionalCheckoutMode: true,
        openaiCalled: false,
      });

      return {
        reply: finalReply,
        toolCallsCount: 0,
        toolNames: [],
        escalated: false,
        state,
        proof: {
          openaiKeySource,
          modelUsed: 'n/a',
          openaiCalled: false,
          openaiSuccess: true,
          transactionalMode: true,
          transactionalCheckoutState: lockCheckoutState,
          deterministicReplyUsed: true,
          skipOpenAiGeneration: true,
        },
      };
    }

    const skipProductSearchRouting = isCheckoutLockedUtterance(userMessage, state);
    const cls = skipProductSearchRouting
      ? { intent: 'quantity_provided' as const, confidence: 0.9, extracted: undefined, rawText: userMessage }
      : classifyOrderTurn(userMessage);

    const intentHint = skipProductSearchRouting
      ? (state.customerIntent ?? 'email_collection')
      : inferIntentHintFromText(userMessage, state) ?? state.customerIntent;

    if (!skipProductSearchRouting && cls.intent === 'product_confirmed') {
      state = applyDeterministicProductSelection(state);
    }

    if (!skipProductSearchRouting && cls.extracted?.quantity) {
      state = mergeCallerSignalsIntoState(state, {
        intentHint: 'quantity_selection',
        quantity: cls.extracted.quantity,
      });
    } else if (!skipProductSearchRouting && intentHint) {
      state = mergeCallerSignalsIntoState(state, { intentHint });
    }

    let totalToolCalls = 0;
    const toolNames: string[] = [];
    let escalated = false;
    let lastContent = emailCapturedReply ?? '';
    let skipLlmToolLoop = emailCapturedReply != null;

    if (shouldTriggerCheckoutAfterEmailConfirmed(state, { emailConfirmedThisTurn })) {
      const confirmMem = await this.callMemory.load(callSessionId);
      const confirmMeta = await loadSessionMeta();
      assertEmailConfirmedBeforeCheckout(
        (confirmMem.emailConfirmationState ??
          confirmMeta.emailConfirmationState) as 'pending' | 'confirmed' | 'rejected' | null,
      );
      const autoResult = await this.runDeterministicCheckoutAfterConfirmedEmail(
        ctx,
        callSessionId,
        state,
        'confirmed_email_checkout',
      );
      state = autoResult.state;
      totalToolCalls = autoResult.toolCallsCount;
      toolNames.push(...autoResult.toolNames);
      lastContent = autoResult.reply;
      skipLlmToolLoop = autoResult.checkoutAttempted;
      skipBrainRewrite = autoResult.checkoutAttempted;
      deterministicReplyUsed = autoResult.checkoutAttempted;
      deliveryConfirmedThisTurn = autoResult.checkoutSucceeded;
    }

    const sessionMeta = await loadSessionMeta();
    const memoryForRouting = await this.callMemory.load(callSessionId);
    let transactionalState = resolveTransactionalCheckoutState({
      llmState: state,
      emailConfirmationState: normalizeEmailConfirmationState(memoryForRouting.emailConfirmationState),
      collectedEmail: memoryForRouting.collectedEmail ?? null,
      orderState: typeof sessionMeta.orderState === 'string' ? sessionMeta.orderState : null,
      emailRetryCount: Number(sessionMeta.emailRetryCount ?? 0),
      emailEnterpriseValidated: sessionMeta.emailEnterpriseValidated === true,
      productCheckoutIntroduced:
        sessionMeta[PRODUCT_CHECKOUT_INTRODUCED_KEY] === true ||
        sessionMeta.productCheckoutIntroduced === true,
    });

    const transactionalRoute =
      emailConfirmedThisTurn || (skipLlmToolLoop && lastContent.trim().length > 0)
        ? {
            handled: false,
            reply: null,
            skipOpenAiGeneration: true,
            transactionalState: emailConfirmedThisTurn
              ? 'EMAIL_CONFIRMED'
              : transactionalState,
            deterministicReplyUsed: false,
          }
        : routeTransactionalCheckoutTurn({
            llmState: state,
            emailConfirmationState: normalizeEmailConfirmationState(
              memoryForRouting.emailConfirmationState,
            ),
            collectedEmail: memoryForRouting.collectedEmail ?? null,
            orderState: typeof sessionMeta.orderState === 'string' ? sessionMeta.orderState : null,
            emailRetryCount: Number(sessionMeta.emailRetryCount ?? 0),
            emailEnterpriseValidated: sessionMeta.emailEnterpriseValidated === true,
            productCheckoutIntroduced:
              sessionMeta[PRODUCT_CHECKOUT_INTRODUCED_KEY] === true ||
              sessionMeta.productCheckoutIntroduced === true,
            userMessage,
            emailCapturedReply,
            emailConfirmedThisTurn,
            customerLanguage,
          });

    if (transactionalRoute.handled && transactionalRoute.reply && !emailConfirmedThisTurn) {
      lastContent = transactionalRoute.reply;
      skipLlmToolLoop = true;
      skipBrainRewrite = true;
      deterministicReplyUsed = transactionalRoute.deterministicReplyUsed;
    }
    if (transactionalRoute.skipOpenAiGeneration) {
      skipLlmToolLoop = true;
    }
    transactionalState = transactionalRoute.transactionalState;

    if (transactionalRoute.statePatch) {
      state = {
        ...state,
        ...transactionalRoute.statePatch,
        transactionalCheckoutState: transactionalState,
      };
    } else if (isTransactionalCheckoutActive(transactionalState)) {
      state = { ...state, transactionalCheckoutState: transactionalState };
    }

    if (transactionalRoute.sessionMetaPatch) {
      await this.callsService.mergeSessionMetadata(callSessionId, transactionalRoute.sessionMetaPatch);
    }

    const transactionalMode = isTransactionalCheckoutActive(transactionalState);
    const skipOpenAiGeneration = skipLlmToolLoop || transactionalRoute.skipOpenAiGeneration;

    this.logger.log(
      JSON.stringify(
        buildTransactionalCheckoutLog({
          callSessionId,
          tenantId: ctx.tenantId,
          agentId: ctx.agentId,
          transactionalMode,
          checkoutState: transactionalState,
          deterministicReplyUsed,
          skipOpenAiGeneration,
          llmCheckoutStage: state.checkoutStage,
        }),
      ),
    );

    if (skipOpenAiGeneration) {
      state.customerIntent = intentHint ?? state.customerIntent;
      await this.persistState(callSessionId, state);
      await this.callsService.mergeSessionMetadata(callSessionId, {
        lastUserIntent: intentHint ?? state.customerIntent ?? 'transactional_checkout',
        [LLM_AGENT_STATE_KEY]: state,
        [TRANSACTIONAL_CHECKOUT_STATE_KEY]: transactionalState,
      });

      const guardedReply = sanitizePaymentSuccessClaim(
        emailConfirmedThisTurn && lastContent.trim()
          ? lastContent.trim()
          : guardTransactionalReply(lastContent || '', {
              transactionalState,
              deliveryConfirmed: deliveryConfirmedThisTurn,
              emailRetryCount: Number(sessionMeta.emailRetryCount ?? 0),
              pendingEmail: memoryForRouting.collectedEmail ?? state.customerEmail ?? null,
            }),
        deliveryConfirmedThisTurn,
      );

      const reply = await finalizeBrainReply(guardedReply, {
        skipRewrite: true,
      });

      const finalReply =
        reply ||
        (emailConfirmedThisTurn && lastContent.trim()
          ? lastContent.trim()
          : buildEmailCollectionPrompt(Number(sessionMeta.emailRetryCount ?? 0)));

      this.logger.log(
        JSON.stringify({
          event: 'voice.brain.final_reply',
          agentId: ctx.agentId,
          sessionId: callSessionId,
          replyPreview: finalReply.slice(0, 240),
          toolCallsUsed: toolNames,
          intent: state.customerIntent ?? intentHint ?? null,
          stateStage: state.checkoutStage,
          transactionalCheckoutState: transactionalState,
          transactionalMode: true,
          skipOpenAiGeneration: true,
          deterministicReplyUsed,
        }),
      );

      return {
        reply: finalReply,
        toolCallsCount: totalToolCalls,
        toolNames,
        escalated,
        state,
        proof: {
          openaiKeySource,
          modelUsed: 'n/a',
          openaiCalled: false,
          openaiSuccess: true,
          transactionalMode: true,
          transactionalCheckoutState: transactionalState,
          deterministicReplyUsed,
          skipOpenAiGeneration: true,
        },
      };
    }

    assertNoOpenAiDuringTransactionalCheckout({
      transactionalCheckoutMode: checkoutLockActive || transactionalCheckoutMode,
      openaiCalled: false,
    });

    this.logger.log(
      JSON.stringify({
        event: 'voice.brain.selected',
        agentId: ctx.agentId,
        sessionId: callSessionId,
        tenantId: ctx.tenantId,
        userText: userMessage.slice(0, 500),
        brain: 'openai_llm_agent_orchestrator',
      }),
    );

    const memorySummary = this.callMemory.summarizeForPrompt(await this.callMemory.load(callSessionId));
    const systemPrompt = buildLlmAgentSystemPrompt({
      state,
      storeName: ctx.store?.name,
      memorySummary,
    });

    const model = normalizeOpenAiChatCompletionsModel(
      ctx.agent.model ?? this.config.get<string>('OPENAI_REALTIME_MODEL') ?? 'gpt-4o-mini',
    );
    const temperatureRaw = ctx.agent.temperature ?? VOICE_COMMERCE_TEMPERATURE_DEFAULT;
    const temperature = Math.min(
      Math.max(Number(temperatureRaw) || VOICE_COMMERCE_TEMPERATURE_DEFAULT, 0),
      VOICE_COMMERCE_TEMPERATURE_CAP,
    );

    const client = new OpenAI({ apiKey });
    const complete: OpenAiCompletionFn =
      options?.completionFn ??
      ((params) => client.chat.completions.create(params));

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: userMessage },
    ];

    let modelToUse = model;
    const fallbackMini = 'gpt-4o-mini';
    let openaiCalled = false;

    if (!skipLlmToolLoop) for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      let response: OpenAI.Chat.ChatCompletion;
      try {
        openaiCalled = true;
        assertNoOpenAiDuringTransactionalCheckout({
          transactionalCheckoutMode:
            transactionalCheckoutMode || checkoutLockActive || transactionalMode,
          openaiCalled: true,
        });
        response = await complete({
          model: modelToUse,
          messages,
          tools: LLM_AGENT_TOOLS as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming['tools'],
          parallel_tool_calls: voiceFastModeParallelToolCalls(),
          max_tokens: voiceLlmMaxTokens(400),
          temperature,
        });
      } catch (err) {
        const status = (err as { status?: number })?.status ?? null;
        const sanitized =
          err instanceof Error ? err.message.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-****').slice(0, 240) : 'openai_failed';
        if (
          (status === 404 || /model_not_found|does not exist/i.test(sanitized)) &&
          modelToUse !== fallbackMini
        ) {
          modelToUse = fallbackMini;
          iter -= 1;
          continue;
        }
        return {
          reply:
            status === 401
              ? 'System error. Please try again later.'
              : ctx.agent.fallbackMessage ??
                "I'm having a brief issue. What book can I help you find?",
          toolCallsCount: totalToolCalls,
          toolNames,
          state,
          escalated,
          error: {
            code: status === 429 ? 'OPENAI_429' : status === 401 ? 'OPENAI_401' : 'OPENAI_ERROR',
            message: sanitized,
          },
          proof: {
            openaiKeySource,
            modelUsed: modelToUse,
            openaiCalled: true,
            openaiSuccess: false,
          },
        };
      }

      const choice = response.choices[0];
      if (!choice) {
        lastContent = ctx.agent.fallbackMessage ?? "I didn't catch that. Could you repeat?";
        break;
      }

      const msg = choice.message;
      if (msg.content && typeof msg.content === 'string') {
        lastContent = msg.content;
      }

      const toolCalls = msg.tool_calls;
      if (!toolCalls?.length) break;

      const maxThisTurn = ctx.agent.maxToolCallsPerTurn ?? MAX_TOOL_CALLS_PER_TURN;
      const toRun = toolCalls.slice(0, maxThisTurn);
      totalToolCalls += toRun.length;

      let stopToolLoopAfterCheckoutFailure = false;

      for (const tc of toRun) {
        if (stopToolLoopAfterCheckoutFailure) break;

        const llmName = (tc.function?.name ?? '') as LlmAgentToolName;
        toolNames.push(llmName);
        let args: Record<string, unknown> = {};
        try {
          args =
            typeof tc.function?.arguments === 'string'
              ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
              : {};
        } catch {
          args = {};
        }

        const { result, followUpContent } = await this.executeLlmTool(
          ctx,
          callSessionId,
          llmName,
          args,
          tc.id,
        );
        state = applyToolResultToState(state, llmName, result);
        if (llmName === 'HumanHandoff' && result.ok) escalated = true;

        if (llmName === 'CreatePaymentLink' && !result.ok) {
          const data = (result.data ?? {}) as Record<string, unknown>;
          if (data.doNotRetryProductLookup === true || result.error?.code === 'CHECKOUT_FAILED') {
            stopToolLoopAfterCheckoutFailure = true;
            if (typeof data.voiceSummary === 'string' && data.voiceSummary.trim()) {
              lastContent = data.voiceSummary.trim();
              skipBrainRewrite = isDeterministicTransactionalReply(lastContent);
            }
          }
        }

        if (llmName === 'CreatePaymentLink' && result.ok) {
          const data = (result.data ?? {}) as Record<string, unknown>;
          if (typeof data.voiceSummary === 'string' && data.voiceSummary.trim()) {
            lastContent = data.voiceSummary.trim();
            skipBrainRewrite = true;
          }
        }

        const output =
          followUpContent ??
          JSON.stringify({
            ok: result.ok,
            data: result.data,
            error: result.error,
          });

        messages.push(
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: tc.id,
                type: 'function',
                function: { name: llmName, arguments: tc.function?.arguments ?? '{}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: tc.id, content: output },
        );

        if (stopToolLoopAfterCheckoutFailure) break;
      }

      if (stopToolLoopAfterCheckoutFailure) break;
    }

    state.customerIntent = intentHint ?? state.customerIntent;
    await this.persistState(callSessionId, state);
    await this.callsService.mergeSessionMetadata(callSessionId, {
      lastUserIntent: intentHint ?? state.customerIntent ?? 'openai_llm',
      [LLM_AGENT_STATE_KEY]: state,
    });

    const reply = await finalizeBrainReply(lastContent || '', {
      skipRewrite: skipBrainRewrite || isDeterministicTransactionalReply(lastContent),
      regenerate: async (draft) => this.rewriteBrainReply(client, modelToUse, draft, temperature),
    });

    const finalReply = emergencyBlockLlmCheckoutReply(
      sanitizePaymentSuccessClaim(
        guardTransactionalReply(reply || '', {
          transactionalState,
          deliveryConfirmed: deliveryConfirmedThisTurn,
          emailRetryCount: Number(sessionMeta.emailRetryCount ?? 0),
          pendingEmail: memoryForRouting.collectedEmail ?? state.customerEmail ?? null,
        }) || "How can I help you with a book today?",
        deliveryConfirmedThisTurn,
      ),
      {
        activeProductSelected: hasSelectedInStockProduct(state),
        openaiCalled,
        emailRetryCount: Number(sessionMeta.emailRetryCount ?? 0),
      },
    );

    assertNoOpenAiDuringTransactionalCheckout({
      transactionalCheckoutMode: checkoutLockActive || transactionalCheckoutMode,
      openaiCalled,
    });

    this.logger.log(
      JSON.stringify({
        event: 'voice.brain.final_reply',
        agentId: ctx.agentId,
        sessionId: callSessionId,
        replyPreview: finalReply.slice(0, 240),
        toolCallsUsed: toolNames,
        intent: state.customerIntent ?? intentHint ?? null,
        stateStage: state.checkoutStage,
        transactionalCheckoutState: transactionalState,
        transactionalMode,
      }),
    );

    return {
      reply: finalReply,
      toolCallsCount: totalToolCalls,
      toolNames,
      escalated,
      state,
      proof: {
        openaiKeySource,
        modelUsed: modelToUse,
        openaiCalled: true,
        openaiSuccess: true,
        transactionalMode,
        transactionalCheckoutState: transactionalState,
        deterministicReplyUsed,
        skipOpenAiGeneration: false,
      },
    };
  }

  private async rewriteBrainReply(
    client: OpenAI,
    model: string,
    draft: string,
    temperature: number,
  ): Promise<string | null> {
    const response = await client.chat.completions.create({
      model,
      temperature: Math.min(temperature, 0.4),
      max_tokens: 120,
      messages: [
        {
          role: 'system',
          content:
            'You are Justin, a professional SureShot Books phone agent. Output only the rewritten spoken line.',
        },
        {
          role: 'user',
          content: `${BRAIN_REWRITE_USER_PROMPT}\n\nDraft:\n${draft}`,
        },
      ],
    });
    return response.choices[0]?.message?.content?.trim() ?? null;
  }

  private async loadState(callSessionId: string): Promise<LlmAgentConversationState> {
    const ctx = await this.sessionContext.load(callSessionId);
    const meta =
      ctx?.metadata && typeof ctx.metadata === 'object' && !Array.isArray(ctx.metadata)
        ? (ctx.metadata as Record<string, unknown>)
        : {};
    return parseLlmAgentState(meta[LLM_AGENT_STATE_KEY]);
  }

  private async persistState(
    callSessionId: string,
    state: LlmAgentConversationState,
  ): Promise<void> {
    await this.callsService.mergeSessionMetadata(callSessionId, {
      [LLM_AGENT_STATE_KEY]: state,
      orderState: this.mapCheckoutStageToOrderState(state.checkoutStage),
    });
  }

  private mapCheckoutStageToOrderState(stage: LlmAgentConversationState['checkoutStage']): string {
    switch (stage) {
      case 'product_discovery':
        return 'PRODUCT_SEARCH';
      case 'product_selected':
        return 'PRODUCT_CONFIRMED';
      case 'quantity':
        return 'QUANTITY_COLLECTED';
      case 'email':
        return 'EMAIL_COLLECTING';
      case 'payment':
        return 'PAYMENT_LINK_SENT';
      case 'done':
        return 'DONE';
      default:
        return 'IDLE';
    }
  }

  private async executeLlmTool(
    ctx: VoiceSessionContext,
    callSessionId: string,
    llmName: string,
    args: Record<string, unknown>,
    requestId: string,
  ): Promise<{ result: ToolResult; followUpContent?: string }> {
    const internal = LLM_TOOL_TO_INTERNAL[llmName as LlmAgentToolName];
    if (!internal) {
      return {
        result: {
          ok: false,
          toolName: llmName,
          storeId: ctx.storeId,
          error: { code: 'UNKNOWN_TOOL', message: `Unknown tool ${llmName}`, retryable: false },
        },
      };
    }

    if (llmName === 'ShopifyProductSearch') {
      await this.callsService.mergeSessionMetadata(callSessionId, {
        lastUserIntent: 'product_search',
      });
    }

    const mappedArgs = mapLlmToolArgs(llmName as LlmAgentToolName, args, {
      fromNumber: ctx.fromNumber,
    });

    if (llmName === 'CreatePaymentLink') {
      const meta = await this.callsService.findOneById(callSessionId);
      const sessionMeta =
        meta.metadata && typeof meta.metadata === 'object' && !Array.isArray(meta.metadata)
          ? (meta.metadata as Record<string, unknown>)
          : {};
      const callMem = await this.callMemory.load(callSessionId);
      const emailConfirmed =
        callMem.emailConfirmationState === 'confirmed' ||
        sessionMeta.emailConfirmationState === 'confirmed';
      if (!emailConfirmed) {
        const pendingEmail = callMem.collectedEmail?.trim();
        return {
          result: {
            ok: false,
            toolName: llmName,
            storeId: ctx.storeId,
            error: {
              code: 'EMAIL_NOT_CONFIRMED',
              message: 'Customer must confirm email before checkout.',
              retryable: true,
            },
            data: {
              voiceSummary: pendingEmail
                ? buildEmailConfirmationPrompt(pendingEmail)
                : buildEmailCollectionPrompt(Number(sessionMeta.emailRetryCount ?? 0)),
            },
          },
        };
      }
      const preState = parseLlmAgentState(sessionMeta[LLM_AGENT_STATE_KEY]);
      const stockBlock = shouldBlockCheckoutForOutOfStock(preState);
      if (stockBlock.blocked) {
        return {
          result: {
            ok: false,
            toolName: llmName,
            storeId: ctx.storeId,
            error: {
              code: 'OUT_OF_STOCK',
              message: stockBlock.message ?? 'Product out of stock',
              retryable: true,
            },
            data: {
              voiceSummary:
                'That book is out of stock, so I cannot send a payment link for it. Would you like a different title that is in stock?',
            },
          },
        };
      }
    }

    let result = await this.toolOrchestrator.execute(
      ctx,
      internal,
      mappedArgs,
      callSessionId,
      requestId,
    );

    if (llmName === 'CreatePaymentLink' && result.ok) {
      const chained = await this.chainSendPaymentEmailAfterCheckout(
        ctx,
        callSessionId,
        result,
        mappedArgs,
        requestId,
      );
      return chained;
    }

    return { result };
  }

  private async runDeterministicCheckoutAfterConfirmedEmail(
    ctx: VoiceSessionContext,
    callSessionId: string,
    state: LlmAgentConversationState,
    requestIdPrefix: string,
  ): Promise<{
    state: LlmAgentConversationState;
    reply: string;
    toolNames: string[];
    toolCallsCount: number;
    checkoutAttempted: boolean;
    checkoutSucceeded: boolean;
  }> {
    const sessionRow = await this.callsService.findOneById(callSessionId);
    const sessionMeta =
      sessionRow.metadata &&
      typeof sessionRow.metadata === 'object' &&
      !Array.isArray(sessionRow.metadata)
        ? (sessionRow.metadata as Record<string, unknown>)
        : {};
    const callMem = await this.callMemory.load(callSessionId);
    assertEmailConfirmedBeforeCheckout(
      (callMem.emailConfirmationState ?? sessionMeta.emailConfirmationState) as
        | 'pending'
        | 'confirmed'
        | 'rejected'
        | null,
    );

    const linkArgs = buildCreatePaymentLinkArgsFromState(state);
    if (!linkArgs) {
      return {
        state,
        reply: '',
        toolNames: [],
        toolCallsCount: 0,
        checkoutAttempted: false,
        checkoutSucceeded: false,
      };
    }

    await this.callsService.mergeSessionMetadata(callSessionId, {
      orderState: 'PAYMENT_LINK_CREATING',
    });

    this.logger.log(
      JSON.stringify({
        event: 'voice.checkout.confirmed_email_checkout',
        callSessionId,
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        email: maskEmailForLog(linkArgs.email),
        itemCount: linkArgs.items.length,
        checkoutStage: state.checkoutStage,
      }),
    );

    const { result: checkoutResult, emailDelivery, emailSendFailureCount } =
      await this.executeCreatePaymentLinkWithEmail(
        ctx,
        callSessionId,
        linkArgs,
        `${requestIdPrefix}-${Date.now()}`,
      );

    let nextState = applyToolResultToState(state, 'CreatePaymentLink', checkoutResult);
    const checkoutData = (checkoutResult.data ?? {}) as Record<string, unknown>;
    const checkoutOk = checkoutResult.ok === true;
    const emailDeliveryParsed = parsePaymentEmailDeliveryFromToolData(
      (emailDelivery?.data ?? {}) as Record<string, unknown>,
      emailDelivery?.ok === true,
    );
    const emailOk = isPaymentEmailDeliveryConfirmed(emailDeliveryParsed);
    const checkoutUrl =
      typeof checkoutData.checkoutUrl === 'string' ? checkoutData.checkoutUrl : undefined;
    const checkoutLinkId =
      typeof checkoutData.checkoutLinkId === 'string' ? checkoutData.checkoutLinkId : undefined;

    if (checkoutOk) {
      nextState = applyPaymentFlowToState(nextState, {
        checkoutLinkId,
        checkoutUrl,
        paymentLinkCreated: true,
        paymentLinkSent: emailOk,
      });
      if (emailOk) {
        await this.callsService.mergeSessionMetadata(callSessionId, {
          orderState: 'PAYMENT_LINK_SENT',
          [TRANSACTIONAL_CHECKOUT_STATE_KEY]: 'PAYMENT_LINK_SENT',
        });
      }
    }

    const toolNames = ['CreatePaymentLink'];
    let toolCallsCount = 1;
    if (emailDelivery) {
      toolNames.push('sendPaymentEmail');
      toolCallsCount += 1;
    }

    const reply = buildConfirmedEmailCheckoutReply({
      email: linkArgs.email,
      checkoutOk,
      emailOk,
      emailApiResult: emailDeliveryParsed,
      checkoutUrl,
      emailSendFailureCount,
    });

    return {
      state: nextState,
      reply,
      toolNames,
      toolCallsCount,
      checkoutAttempted: true,
      checkoutSucceeded: checkoutOk && emailOk,
    };
  }

  private async executeCreatePaymentLinkWithEmail(
    ctx: VoiceSessionContext,
    callSessionId: string,
    linkArgs: { email: string; items: Array<{ variantId: string; quantity: number }> },
    requestId: string,
  ): Promise<{
    result: ToolResult;
    emailDelivery: ToolResult | null;
    emailSendFailureCount: number;
  }> {
    const stockBlock = shouldBlockCheckoutForOutOfStock(
      await this.loadState(callSessionId),
    );
    if (stockBlock.blocked) {
      return {
        result: {
          ok: false,
          toolName: 'CreatePaymentLink',
          storeId: ctx.storeId,
          error: {
            code: 'OUT_OF_STOCK',
            message: stockBlock.message ?? 'Product out of stock',
            retryable: true,
          },
          data: {
            voiceSummary:
              'That book is out of stock, so I cannot send a payment link for it. Would you like a different title that is in stock?',
          },
        },
        emailDelivery: null,
        emailSendFailureCount: 0,
      };
    }

    const mappedArgs = mapLlmToolArgs('CreatePaymentLink', linkArgs);
    const checkoutResult = await this.toolOrchestrator.execute(
      ctx,
      'createCheckoutLink',
      mappedArgs,
      callSessionId,
      requestId,
    );

    if (!checkoutResult.ok) {
      return { result: checkoutResult, emailDelivery: null, emailSendFailureCount: 0 };
    }

    const checkoutData = (checkoutResult.data ?? {}) as Record<string, unknown>;
    this.logger.log(
      JSON.stringify(
        buildCheckoutJourneyLog('payment_link_created', {
          callSessionId,
          tenantId: ctx.tenantId,
          agentId: ctx.agentId,
          checkoutLinkId: checkoutData.checkoutLinkId ?? null,
        }),
      ),
    );

    const sessionRow = await this.callsService.findOneById(callSessionId);
    const sessionMeta =
      sessionRow.metadata &&
      typeof sessionRow.metadata === 'object' &&
      !Array.isArray(sessionRow.metadata)
        ? (sessionRow.metadata as Record<string, unknown>)
        : {};
    let emailSendFailureCount = Number(sessionMeta.emailSendFailureCount ?? 0);
    let emailDelivery: ToolResult | null = null;
    let chainedResult = checkoutResult;

    for (let attempt = 0; attempt < MAX_EMAIL_SEND_RETRIES; attempt++) {
      const chained = await this.chainSendPaymentEmailAfterCheckout(
        ctx,
        callSessionId,
        chainedResult,
        mappedArgs,
        `${requestId}-email-${attempt}`,
      );
      chainedResult = chained.result;
      emailDelivery = chained.emailDelivery ?? null;

      if (emailDelivery?.ok) {
        if (emailSendFailureCount > 0) {
          await this.callsService.mergeSessionMetadata(callSessionId, {
            emailSendFailureCount: 0,
          });
        }
        break;
      }

      emailSendFailureCount += 1;
      await this.callsService.mergeSessionMetadata(callSessionId, {
        emailSendFailureCount,
      });
      this.logger.warn(
        JSON.stringify(
          buildVoiceEmailCaptureLog({
            event: 'voice.email.send_error',
            callSessionId,
            tenantId: ctx.tenantId,
            agentId: ctx.agentId,
            maskedEmail: maskEmailForLog(linkArgs.email),
            sendOk: false,
            sendFailureCount: emailSendFailureCount,
            errorCode: emailDelivery?.error?.code ?? 'EMAIL_SEND_FAILED',
          }),
        ),
      );

      if (emailSendFailureCount >= MAX_EMAIL_SEND_RETRIES) break;
    }

    return {
      result: chainedResult,
      emailDelivery,
      emailSendFailureCount,
    };
  }

  private async chainSendPaymentEmailAfterCheckout(
    ctx: VoiceSessionContext,
    callSessionId: string,
    checkoutResult: ToolResult,
    mappedArgs: Record<string, unknown>,
    requestId: string,
  ): Promise<{
    result: ToolResult;
    followUpContent?: string;
    emailDelivery?: ToolResult;
  }> {
    const data = (checkoutResult.data ?? {}) as Record<string, unknown>;
    const checkoutLinkId = data.checkoutLinkId as string | undefined;
    const checkoutUrl = typeof data.checkoutUrl === 'string' ? data.checkoutUrl : undefined;
    const email = String(mappedArgs.email ?? '').trim();
    if (!checkoutLinkId || !email) {
      return { result: checkoutResult };
    }

    await this.callsService.mergeSessionMetadata(callSessionId, {
      orderState: 'PAYMENT_LINK_CREATING',
      emailConfirmationState: 'confirmed',
      normalizedEmail: email,
      paymentLink: checkoutUrl,
    });

    const emailResult = await this.toolOrchestrator.execute(
      ctx,
      'sendPaymentEmail',
      { checkoutLinkId, email },
      callSessionId,
      `${requestId}-email`,
    );

    const delivery = parsePaymentEmailDeliveryFromToolData(
      (emailResult.data ?? {}) as Record<string, unknown>,
      emailResult.ok === true,
    );
    const emailOk = isPaymentEmailDeliveryConfirmed(delivery);
    if (emailOk) {
      this.logger.log(
        JSON.stringify(
          buildCheckoutJourneyLog('payment_email_delivery_confirmed', {
            callSessionId,
            tenantId: ctx.tenantId,
            agentId: ctx.agentId,
            maskedEmail: maskEmailForLog(email),
            providerSuccess: delivery.providerSuccess,
            deliveryQueued: delivery.deliveryQueued,
          }),
        ),
      );
      this.logger.log(
        JSON.stringify(
          buildVoiceEmailCaptureLog({
            event: 'voice.email.delivery_confirmed',
            callSessionId,
            tenantId: ctx.tenantId,
            agentId: ctx.agentId,
            maskedEmail: maskEmailForLog(email),
            sendOk: true,
            smtpAccepted: delivery.smtpAccepted,
            providerSuccess: delivery.providerSuccess,
            deliveryQueued: delivery.deliveryQueued,
            confirmationStatus: 'confirmed',
          }),
        ),
      );
      await this.callsService.mergeSessionMetadata(callSessionId, {
        orderState: 'PAYMENT_LINK_SENT',
      });
    } else {
      this.logger.warn(
        JSON.stringify(
          buildVoiceEmailCaptureLog({
            event: 'voice.email.send_error',
            callSessionId,
            tenantId: ctx.tenantId,
            agentId: ctx.agentId,
            maskedEmail: maskEmailForLog(email),
            sendOk: false,
            errorCode: emailResult.error?.code ?? 'EMAIL_FAILED',
          }),
        ),
      );
    }

    const sessionRow = await this.callsService.findOneById(callSessionId);
    const sessionMeta =
      sessionRow.metadata &&
      typeof sessionRow.metadata === 'object' &&
      !Array.isArray(sessionRow.metadata)
        ? (sessionRow.metadata as Record<string, unknown>)
        : {};
    const emailSendFailureCount = Number(sessionMeta.emailSendFailureCount ?? (emailOk ? 0 : 1));

    const voiceSummary = buildConfirmedEmailCheckoutReply({
      email,
      checkoutOk: true,
      emailOk,
      emailApiResult: delivery,
      checkoutUrl,
      emailSendFailureCount,
    });

    return {
      result: {
        ...checkoutResult,
        data: {
          ...data,
          emailSent: emailOk,
          voiceSummary,
        },
      },
      emailDelivery: emailResult,
      followUpContent: JSON.stringify({
        checkout: checkoutResult.data,
        emailDelivery: emailResult.data ?? emailResult.error,
        ok: checkoutResult.ok && emailOk,
        voiceSummary,
      }),
    };
  }
}
