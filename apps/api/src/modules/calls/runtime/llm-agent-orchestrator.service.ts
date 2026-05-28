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
import { normalizeSpokenEmail } from './email-normalization.util';
import { shouldBlockCheckoutForOutOfStock } from './voice-stock-sales-policy.util';

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
    const intentHint = inferIntentHintFromText(userMessage) ?? state.customerIntent;
    state = mergeCallerSignalsIntoState(state, {
      intentHint,
      quantity: cls.extracted?.quantity,
      email: cls.extracted?.email ? normalizeSpokenEmail(cls.extracted.email) : undefined,
    });
    if (state.customerEmail) {
      await this.callMemory.setEmailState(callSessionId, state.customerEmail, 'confirmed');
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

    let totalToolCalls = 0;
    const toolNames: string[] = [];
    let escalated = false;
    let lastContent = '';
    let modelToUse = model;
    const fallbackMini = 'gpt-4o-mini';

    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
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

      for (const tc of toRun) {
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
      }
    }

    state.customerIntent = intentHint ?? state.customerIntent;
    await this.persistState(callSessionId, state);
    await this.callsService.mergeSessionMetadata(callSessionId, {
      lastUserIntent: intentHint ?? state.customerIntent ?? 'openai_llm',
      [LLM_AGENT_STATE_KEY]: state,
    });

    const reply = await finalizeBrainReply(lastContent || '', {
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
      const data = (result.data ?? {}) as Record<string, unknown>;
      const checkoutLinkId = data.checkoutLinkId as string | undefined;
      const email = String(mappedArgs.email ?? '').trim();
      if (checkoutLinkId && email) {
        await this.callsService.mergeSessionMetadata(callSessionId, {
          orderState: 'PAYMENT_LINK_CREATING',
          emailConfirmationState: 'confirmed',
          normalizedEmail: email,
        });
        const emailResult = await this.toolOrchestrator.execute(
          ctx,
          'sendPaymentEmail',
          { checkoutLinkId, email },
          callSessionId,
          `${requestId}-email`,
        );
        return {
          result: emailResult.ok ? emailResult : result,
          followUpContent: JSON.stringify({
            checkout: result.data,
            emailDelivery: emailResult.data ?? emailResult.error,
            ok: result.ok && emailResult.ok,
          }),
        };
      }
    }

    return { result };
  }
}
