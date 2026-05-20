import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { OpenAIPromptBuilderService } from './openai-prompt-builder.service';
import { OpenAIToolRegistryService } from './openai-tool-registry.service';
import { SessionContextService } from '../../calls/runtime/session-context.service';
import { ToolOrchestratorService } from '../../calls/runtime/tool-orchestrator.service';
import {
  applyVoiceToolTrace,
  type VoiceTurnToolTrace,
} from '../../calls/runtime/voice-turn-tool-trace.util';
import { normalizeOpenAiChatCompletionsModel } from './voice-tool-schema.util';

/** Enough rounds for search → details → checkout → email in one caller utterance. */
const MAX_TOOL_ITERATIONS = Number(process.env.MAX_TOOL_ITERATIONS_VOICE) || 8;
const MAX_TOOL_CALLS_PER_TURN = Number(process.env.MAX_TOOL_CALLS_PER_TURN) || 4;
/** Commerce default: lower temperature reduces invented SKUs and policy drift. */
const VOICE_COMMERCE_TEMPERATURE_CAP = Number(process.env.VOICE_COMMERCE_TEMPERATURE_CAP) || 0.45;
const VOICE_COMMERCE_TEMPERATURE_DEFAULT = Number(process.env.VOICE_COMMERCE_TEMPERATURE_DEFAULT) || 0.35;

/** Safe key fingerprint for logs (never log full secret). */
function openaiKeyFingerprint(key: string | undefined | null): {
  present: boolean;
  first8: string | null;
  last4: string | null;
} {
  const t = key?.trim();
  if (!t) return { present: false, first8: null, last4: null };
  return {
    present: true,
    first8: t.slice(0, 8),
    last4: t.length >= 4 ? t.slice(-4) : t,
  };
}

const OPENAI_401_REMEDIATION =
  'OpenAI returned 401 (invalid API key). SessionContextService resolves keys in order: (1) agent secretsEnc openaiApiKey, (2) TenantIntegration.openaiApiKeyEnc, (3) OPENAI_API_KEY env. Per-agent key wins over workspace; clear the agent OpenAI field to use Settings. Restart the API after changing .env only for the env fallback.';

/** Caller-facing line on auth failure — do not substitute agent fallback prompts. */
const OPENAI_401_CALLER_MESSAGE = 'System error. Please try again later.';

export type { VoiceTurnToolTrace } from '../../calls/runtime/voice-turn-tool-trace.util';

export interface ProcessTurnResult {
  message: string;
  toolCallsCount: number;
  escalated?: boolean;
  toolTrace?: VoiceTurnToolTrace;
  error?: { code: 'OPENAI_429' | 'OPENAI_401' | 'OPENAI_ERROR'; status?: number; message?: string };
  /** Safe diagnostics for Twilio/runtime logs — never includes secrets. */
  proof?: {
    openaiKeySource: string;
    modelUsed: string;
    openaiCalled: boolean;
    openaiSuccess: boolean;
    replyPreview: string;
  };
}

@Injectable()
export class OpenAIVoiceService {
  private readonly logger = new Logger(OpenAIVoiceService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly promptBuilder: OpenAIPromptBuilderService,
    private readonly toolRegistry: OpenAIToolRegistryService,
    private readonly sessionContext: SessionContextService,
    private readonly toolOrchestrator: ToolOrchestratorService,
  ) {
  }

  /**
   * Process one user utterance: build prompt, call OpenAI with tools, run tool loop, return final reply.
   */
  async processTurn(
    callSessionId: string,
    userMessage: string,
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): Promise<ProcessTurnResult> {
    const ctx = await this.sessionContext.load(callSessionId);
    if (!ctx) {
      this.logger.warn(JSON.stringify({ event: 'voice.journey.context_missing', callSessionId }));
      return { message: "I'm sorry, I lost context. Please try again.", toolCallsCount: 0 };
    }

    const openaiKeySource = ctx.agent.runtimeCredentialHints?.openaiKeySource ?? 'none';
    const apiKey = ctx.agent.openaiApiKey?.trim() ?? '';
    const envKeyRaw = this.config.get<string>('OPENAI_API_KEY')?.trim() ?? '';
    const effectiveFp = openaiKeyFingerprint(apiKey || envKeyRaw);

    this.logger.log(
      JSON.stringify({
        event: 'voice.journey.openai_key_resolution',
        provider: 'openai',
        operation: 'runtime',
        callSessionId,
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        openaiKeySource,
        sessionContextMergeOrder: 'agent_secrets → tenant_openaiApiKeyEnc → OPENAI_API_KEY (see voice-config-resolution.util.ts)',
        hasApiKey: Boolean(apiKey),
        keyLength: apiKey?.length ?? 0,
        envFallbackStillSet: Boolean(envKeyRaw),
        effectiveKeyFingerprint: effectiveFp.present ? { first8: effectiveFp.first8, last4: effectiveFp.last4 } : null,
      }),
    );
    if (!apiKey) {
      this.logger.warn(
        JSON.stringify({
          event: 'voice.journey.openai_key_missing',
          callSessionId,
          tenantId: ctx.tenantId,
          agentId: ctx.agentId,
          openaiKeySource,
        }),
      );
      return {
        message: ctx.agent.fallbackMessage ?? "I'm having trouble right now. Please call back later.",
        toolCallsCount: 0,
        proof: {
          openaiKeySource,
          modelUsed: normalizeOpenAiChatCompletionsModel(
            ctx.agent.model ?? this.config.get<string>('OPENAI_REALTIME_MODEL') ?? 'gpt-4o-mini',
          ),
          openaiCalled: false,
          openaiSuccess: false,
          replyPreview: '',
        },
      };
    }

    const systemPrompt = this.promptBuilder.build(ctx);
    const tools = this.toolRegistry.getToolsForAgent(ctx.agent.enabledTools);
    const model = normalizeOpenAiChatCompletionsModel(
      ctx.agent.model ?? this.config.get<string>('OPENAI_REALTIME_MODEL') ?? 'gpt-4o-mini',
    );
    const client = new OpenAI({ apiKey });
    const temperatureRaw = ctx.agent.temperature ?? VOICE_COMMERCE_TEMPERATURE_DEFAULT;
    const temperature = Math.min(Math.max(Number(temperatureRaw) || VOICE_COMMERCE_TEMPERATURE_DEFAULT, 0), VOICE_COMMERCE_TEMPERATURE_CAP);

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: userMessage },
    ];

    this.logger.log(
      JSON.stringify({
        event: 'voice.journey.openai_turn_ready',
        callSessionId,
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        modelConfigured: model,
        toolCount: tools.length,
        historyMessages: conversationHistory.length,
        userMessagePreview: userMessage.slice(0, 200),
      }),
    );

    let totalToolCalls = 0;
    let escalated = false;
    let lastContent = '';
    const toolTrace: VoiceTurnToolTrace = {};

    let modelToUse = model;
    const fallbackMini = 'gpt-4o-mini';

    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      let response: OpenAI.Chat.ChatCompletion;
      try {
        response = await client.chat.completions.create({
          model: modelToUse,
          messages,
          tools: tools.length > 0 ? (tools as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming['tools']) : undefined,
          parallel_tool_calls: false,
          max_tokens: 400,
          temperature,
        });
      } catch (err) {
        const status = (err as { status?: number })?.status ?? null;
        const sanitized =
          err instanceof Error
            ? err.message
                .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-****')
                .replace(/sk-proj-[A-Za-z0-9_-]{8,}/g, 'sk-proj-****')
                .slice(0, 240)
            : 'openai_request_failed';
        const msg = sanitized;
        const looksLikeBadModel =
          status === 404 ||
          /model_not_found|does not exist|invalid model|unknown model|model\s*[:=]/i.test(sanitized);
        if (looksLikeBadModel && modelToUse !== fallbackMini) {
          this.logger.warn(
            JSON.stringify({
              event: 'voice.journey.openai_model_fallback',
              callSessionId,
              tenantId: ctx.tenantId,
              agentId: ctx.agentId,
              fromModel: modelToUse,
              toModel: fallbackMini,
              responseStatus: status,
              error: sanitized,
            }),
          );
          modelToUse = fallbackMini;
          iter -= 1;
          continue;
        }
        const is401 = status === 401;
        if (is401) {
          console.error({
            event: 'voice.journey.openai_401_invalid_api_key',
            callSessionId,
            tenantId: ctx.tenantId,
            agentId: ctx.agentId,
            openaiKeySource,
            modelAttempted: modelToUse,
            responseStatus: status,
            remediation: OPENAI_401_REMEDIATION,
          });
        }
        this.logger.error(
          JSON.stringify({
            event: is401 ? 'voice.journey.openai_401_invalid_api_key' : 'voice.journey.openai_request_failed',
            callSessionId,
            tenantId: ctx.tenantId,
            agentId: ctx.agentId,
            provider: 'openai',
            operation: 'runtime',
            hasApiKey: true,
            keyLength: apiKey.length,
            openaiKeySource,
            modelAttempted: modelToUse,
            responseStatus: status,
            error: sanitized,
            iteration: iter,
            message: msg,
            ...(is401 ? { remediation: OPENAI_401_REMEDIATION, callerMessage: OPENAI_401_CALLER_MESSAGE } : {}),
          }),
        );
        if (is401) {
          return {
            message: OPENAI_401_CALLER_MESSAGE,
            toolCallsCount: totalToolCalls,
            escalated,
            error: {
              code: 'OPENAI_401',
              status: 401,
              message: sanitized,
            },
            proof: {
              openaiKeySource,
              modelUsed: modelToUse,
              openaiCalled: true,
              openaiSuccess: false,
              replyPreview: OPENAI_401_CALLER_MESSAGE,
            },
          };
        }
        return {
          message:
            ctx.agent.fallbackMessage ??
            "I can still help right now. Please say the product name and size, and I will check availability.",
          toolCallsCount: totalToolCalls,
          escalated,
          error: {
            code: status === 429 ? 'OPENAI_429' : 'OPENAI_ERROR',
            status: typeof status === 'number' ? status : undefined,
            message: sanitized,
          },
          proof: {
            openaiKeySource,
            modelUsed: modelToUse,
            openaiCalled: true,
            openaiSuccess: false,
            replyPreview: '',
          },
        };
      }

      const choice = response.choices[0];
      if (!choice) {
        lastContent = ctx.agent.fallbackMessage ?? "I didn't get that. Can you repeat?";
        this.logger.warn(
          JSON.stringify({
            event: 'voice.journey.openai_empty_choice',
            callSessionId,
            iteration: iter,
          }),
        );
        break;
      }

      const msg = choice.message;
      const content = msg.content;
      if (content) {
        if (typeof content === 'string') {
          lastContent = content;
        } else if (Array.isArray(content)) {
          const parts = content as Array<{ type?: string; text?: string }>;
          lastContent = parts.map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('');
        }
      }

      const toolCalls = msg.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        this.logger.log(
          JSON.stringify({
            event: 'voice.journey.openai_final_message',
            callSessionId,
            iteration: iter,
            modelUsed: modelToUse,
            hasContent: Boolean(lastContent?.trim()),
            replyPreview: (lastContent ?? '').slice(0, 300),
          }),
        );
        break;
      }

      const maxThisTurn = ctx.agent.maxToolCallsPerTurn ?? MAX_TOOL_CALLS_PER_TURN;
      const toRun = toolCalls.slice(0, maxThisTurn);
      totalToolCalls += toRun.length;
      if (toolCalls.length > maxThisTurn) {
        this.logger.warn(
          JSON.stringify({
            event: 'voice.journey.tool_batch_truncated',
            callSessionId,
            iteration: iter,
            requested: toolCalls.length,
            executed: toRun.length,
          }),
        );
      }

      this.logger.log(
        JSON.stringify({
          event: 'voice.journey.tool_batch',
          callSessionId,
          iteration: iter,
          toolNames: toRun.map((t) => t.function?.name ?? 'unknown'),
          batchSize: toRun.length,
        }),
      );

      for (const tc of toRun) {
        const name = tc.function?.name ?? '';
        let args: Record<string, unknown> = {};
        try {
          args = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : {};
        } catch {
          args = {};
          this.logger.warn(
            JSON.stringify({
              event: 'voice.journey.tool_args_parse_failed',
              callSessionId,
              toolName: name,
            }),
          );
        }
        const result = await this.toolOrchestrator.execute(ctx, name, args, callSessionId, tc.id);
        applyVoiceToolTrace(toolTrace, name, args, result);
        const output = JSON.stringify(result);
        messages.push(
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: tc.id,
                type: 'function',
                function: { name, arguments: tc.function?.arguments ?? '{}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: tc.id, content: output },
        );
        if ((name === 'handoff_to_human' || name === 'escalateToHuman') && result.ok) {
          escalated = true;
        }
      }
    }

    return {
      message:
        lastContent ||
        ctx.agent.fallbackMessage ||
        "I'm sorry, I couldn't complete that. How else can I help?",
      toolCallsCount: totalToolCalls,
      escalated,
      toolTrace: totalToolCalls > 0 ? toolTrace : undefined,
      proof: {
        openaiKeySource,
        modelUsed: modelToUse,
        openaiCalled: true,
        openaiSuccess: true,
        replyPreview: (lastContent || '').slice(0, 240),
      },
    };
  }
}
