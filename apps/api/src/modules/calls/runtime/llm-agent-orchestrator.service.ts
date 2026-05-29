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
  buildEmailCollectionPrompt,
  buildEmailConfirmationPrompt,
  buildInvalidEmailRetryPrompt,
  buildVoiceEmailCaptureLog,
  isDeterministicTransactionalReply,
  isEmailConfirmationAffirmative,
  isEmailConfirmationNegative,
  maskEmailForLog,
  maskRawSpeechForLog,
  MAX_EMAIL_SEND_RETRIES,
  nextEmailRetryCount,
  shouldOfferEmailRetry,
  validateVoiceEmail,
} from './voice-email-capture.util';
import { shouldBlockCheckoutForOutOfStock } from './voice-stock-sales-policy.util';
import {
  applyPaymentFlowToState,
  buildAutoCheckoutConfirmationReply,
  buildCreatePaymentLinkArgsFromState,
  shouldAutoTriggerCheckoutAfterEmail,
} from './llm-agent-auto-checkout.util';

const MAX_TOOL_ITERATIONS = Number(process.env.MAX_TOOL_ITERATIONS_VOICE) || 8;
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
    options?: { completionFn?: OpenAiCompletionFn },
  ): Promise<LlmAgentTurnResult> {
    return this.processTurn(callSessionId, userMessage, conversationHistory, options);
  }

  async processTurn(
    callSessionId: string,
    userMessage: string,
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
    options?: { completionFn?: OpenAiCompletionFn },
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
    const cls = classifyOrderTurn(userMessage);
    const memory = await this.callMemory.load(callSessionId);
    const intentHint = inferIntentHintFromText(userMessage) ?? state.customerIntent;
    let emailConfirmedThisTurn = false;
    let emailCapturedReply: string | null = null;
    let skipBrainRewrite = false;

    const loadEmailRetryCount = async (): Promise<number> => {
      const sessionRow = await this.callsService.findOneById(callSessionId);
      const sessionMeta =
        sessionRow.metadata &&
        typeof sessionRow.metadata === 'object' &&
        !Array.isArray(sessionRow.metadata)
          ? (sessionRow.metadata as Record<string, unknown>)
          : {};
      return Number(sessionMeta.emailRetryCount ?? 0);
    };

    if (
      memory.emailConfirmationState === 'pending' &&
      memory.collectedEmail?.trim() &&
      isEmailConfirmationAffirmative(userMessage)
    ) {
      const confirmedEmail = memory.collectedEmail.trim();
      await this.callMemory.setEmailState(callSessionId, confirmedEmail, 'confirmed');
      await this.callsService.mergeSessionMetadata(callSessionId, {
        orderState: 'EMAIL_CONFIRMING',
        normalizedEmail: confirmedEmail,
        emailConfirmationState: 'confirmed',
      });
      state = mergeCallerSignalsIntoState(state, { email: confirmedEmail });
      emailConfirmedThisTurn = true;
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
      memory.emailConfirmationState === 'pending' &&
      isEmailConfirmationNegative(userMessage)
    ) {
      const nextRetry = nextEmailRetryCount(await loadEmailRetryCount(), false);
      await this.callMemory.setEmailState(callSessionId, '', 'pending');
      await this.callsService.mergeSessionMetadata(callSessionId, {
        orderState: 'EMAIL_COLLECTING',
        normalizedEmail: '',
        emailConfirmationState: 'pending',
        emailRetryCount: nextRetry,
      });
      emailCapturedReply = shouldOfferEmailRetry(nextRetry)
        ? buildInvalidEmailRetryPrompt(nextRetry)
        : buildEmailCollectionPrompt(nextRetry);
      skipBrainRewrite = true;
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
    } else if (cls.extracted?.email) {
      const emailRetryCount = await loadEmailRetryCount();
      const validation = validateVoiceEmail(cls.extracted.email);
      this.logger.log(
        JSON.stringify(
          buildVoiceEmailCaptureLog({
            event: 'voice.email.captured',
            callSessionId,
            tenantId: ctx.tenantId,
            agentId: ctx.agentId,
            rawPreview: maskRawSpeechForLog(cls.extracted.email),
            normalizedPreview: validation.normalized,
            maskedEmail: maskEmailForLog(validation.normalized),
            valid: validation.valid,
            retryCount: emailRetryCount,
          }),
        ),
      );
      if (validation.valid) {
        state = mergeCallerSignalsIntoState(state, { email: validation.normalized });
        await this.callMemory.setEmailState(callSessionId, validation.normalized, 'pending');
        await this.callsService.mergeSessionMetadata(callSessionId, {
          orderState: 'EMAIL_CONFIRMING',
          normalizedEmail: validation.normalized,
          emailConfirmationState: 'pending',
        });
        emailCapturedReply = buildEmailConfirmationPrompt(validation.normalized);
        skipBrainRewrite = true;
      } else {
        const retryCount = nextEmailRetryCount(emailRetryCount, false);
        await this.callsService.mergeSessionMetadata(callSessionId, {
          orderState: 'EMAIL_COLLECTING',
          emailRetryCount: retryCount,
          emailConfirmationState: 'pending',
        });
        emailCapturedReply = buildInvalidEmailRetryPrompt(retryCount);
        skipBrainRewrite = true;
        this.logger.log(
          JSON.stringify(
            buildVoiceEmailCaptureLog({
              event: 'voice.email.validated',
              callSessionId,
              tenantId: ctx.tenantId,
              agentId: ctx.agentId,
              rawPreview: maskRawSpeechForLog(cls.extracted.email),
              normalizedPreview: validation.normalized,
              valid: false,
              retryCount,
            }),
          ),
        );
      }
    } else if (
      !memory.collectedEmail?.trim() &&
      memory.emailConfirmationState !== 'pending' &&
      state.checkoutStage === 'email' &&
      !cls.extracted?.email
    ) {
      emailCapturedReply = buildEmailCollectionPrompt(await loadEmailRetryCount());
      skipBrainRewrite = true;
    } else {
      state = mergeCallerSignalsIntoState(state, {
        intentHint,
        quantity: cls.extracted?.quantity,
      });
    }

    let totalToolCalls = 0;
    const toolNames: string[] = [];
    let escalated = false;
    let lastContent = emailCapturedReply ?? '';
    let skipLlmToolLoop = emailCapturedReply != null;

    if (shouldAutoTriggerCheckoutAfterEmail(state, { emailConfirmedThisTurn })) {
      const autoResult = await this.runDeterministicCheckoutAfterEmail(
        ctx,
        callSessionId,
        state,
        'auto_email_capture',
      );
      state = autoResult.state;
      totalToolCalls = autoResult.toolCallsCount;
      toolNames.push(...autoResult.toolNames);
      lastContent = autoResult.reply;
      skipLlmToolLoop = autoResult.checkoutAttempted;
      skipBrainRewrite = autoResult.checkoutAttempted;
    }

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

    if (!skipLlmToolLoop) for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      let response: OpenAI.Chat.ChatCompletion;
      try {
        response = await complete({
          model: modelToUse,
          messages,
          tools: LLM_AGENT_TOOLS as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming['tools'],
          parallel_tool_calls: false,
          max_tokens: 400,
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

    const finalReply = reply || "How can I help you with a book today?";

    this.logger.log(
      JSON.stringify({
        event: 'voice.brain.final_reply',
        agentId: ctx.agentId,
        sessionId: callSessionId,
        replyPreview: finalReply.slice(0, 240),
        toolCallsUsed: toolNames,
        intent: state.customerIntent ?? intentHint ?? null,
        stateStage: state.checkoutStage,
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

  private async runDeterministicCheckoutAfterEmail(
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

    this.logger.log(
      JSON.stringify({
        event: 'voice.checkout.auto_triggered_after_email',
        callSessionId,
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        email: linkArgs.email.replace(/^(.).+(@.*)$/, '$1***$2'),
        itemCount: linkArgs.items.length,
        checkoutStage: state.checkoutStage,
      }),
    );

    await this.callsService.mergeSessionMetadata(callSessionId, {
      orderState: 'PAYMENT_LINK_CREATING',
    });

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
    const emailOk = emailDelivery?.ok === true;
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
        });
      }
    }

    const toolNames = ['CreatePaymentLink'];
    let toolCallsCount = 1;
    if (emailDelivery) {
      toolNames.push('sendPaymentEmail');
      toolCallsCount += 1;
    }

    const reply = buildAutoCheckoutConfirmationReply({
      email: linkArgs.email,
      checkoutOk,
      emailOk,
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
      JSON.stringify({
        event: 'voice.checkout.payment_link_created',
        callSessionId,
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        checkoutLinkId: checkoutData.checkoutLinkId ?? null,
      }),
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

    const emailOk = emailResult.ok === true;
    if (emailOk) {
      this.logger.log(
        JSON.stringify(
          buildVoiceEmailCaptureLog({
            event: 'voice.email.send_status',
            callSessionId,
            tenantId: ctx.tenantId,
            agentId: ctx.agentId,
            maskedEmail: maskEmailForLog(email),
            sendOk: true,
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

    const voiceSummary = buildAutoCheckoutConfirmationReply({
      email,
      checkoutOk: true,
      emailOk,
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
