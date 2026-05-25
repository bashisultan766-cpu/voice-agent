import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { SessionContextService } from '../../calls/runtime/session-context.service';
import { OpenAIPromptBuilderService } from './openai-prompt-builder.service';
import { OpenAIToolRegistryService } from './openai-tool-registry.service';
import { normalizeOpenAiChatCompletionsModel } from './voice-tool-schema.util';

const VOICE_COMMERCE_TEMPERATURE_DEFAULT = Number(process.env.VOICE_COMMERCE_TEMPERATURE_DEFAULT) || 0.35;
const VOICE_COMMERCE_TEMPERATURE_CAP = Number(process.env.VOICE_COMMERCE_TEMPERATURE_CAP) || 0.45;

export type StreamingLlmResult = {
  fullText: string;
  timeToFirstTokenMs: number | null;
  totalMs: number;
  usage?: { promptTokens?: number; completionTokens?: number };
  streamed: boolean;
};

/**
 * Stream final assistant text when no tool calls are required (low latency path).
 * Falls back to empty if streaming unsupported for the turn.
 */
@Injectable()
export class OpenAIStreamingVoiceService {
  private readonly logger = new Logger(OpenAIStreamingVoiceService.name);

  constructor(
    private readonly sessionContext: SessionContextService,
    private readonly promptBuilder: OpenAIPromptBuilderService,
    private readonly toolRegistry: OpenAIToolRegistryService,
  ) {}

  async streamAssistantReply(
    callSessionId: string,
    userMessage: string,
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
    onToken?: (delta: string) => void,
  ): Promise<StreamingLlmResult> {
    const started = Date.now();
    const ctx = await this.sessionContext.load(callSessionId);
    if (!ctx?.agent.openaiApiKey?.trim()) {
      return { fullText: '', timeToFirstTokenMs: null, totalMs: 0, streamed: false };
    }

    const apiKey = ctx.agent.openaiApiKey.trim();
    const systemPrompt = this.promptBuilder.build(ctx);
    const tools = this.toolRegistry.getToolsForAgent({
      enabledTools: ctx.agent.enabledTools,
      toolPermissions: ctx.agent.toolPermissions,
    });
    const model = normalizeOpenAiChatCompletionsModel(ctx.agent.model ?? 'gpt-4o-mini');
    const client = new OpenAI({ apiKey });
    const temperature = Math.min(
      Math.max(Number(ctx.agent.temperature ?? VOICE_COMMERCE_TEMPERATURE_DEFAULT), 0),
      VOICE_COMMERCE_TEMPERATURE_CAP,
    );

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: userMessage },
    ];

    let fullText = '';
    let timeToFirstTokenMs: number | null = null;
    let usage: StreamingLlmResult['usage'];

    try {
      const stream = await client.chat.completions.create({
        model,
        messages,
        tools: tools.length > 0 ? (tools as OpenAI.Chat.ChatCompletionCreateParamsStreaming['tools']) : undefined,
        tool_choice: tools.length > 0 ? 'none' : undefined,
        stream: true,
        max_tokens: 400,
        temperature,
      });

      for await (const part of stream) {
        const choice = part.choices[0];
        const delta = choice?.delta?.content ?? '';
        if (delta) {
          if (timeToFirstTokenMs == null) timeToFirstTokenMs = Date.now() - started;
          fullText += delta;
          onToken?.(delta);
        }
        if (part.usage) {
          usage = {
            promptTokens: part.usage.prompt_tokens,
            completionTokens: part.usage.completion_tokens,
          };
        }
        if (choice?.delta?.tool_calls?.length) {
          this.logger.log(
            JSON.stringify({
              event: 'voice.stream.llm_tools_required',
              callSessionId,
              note: 'streaming aborted — caller should use full tool loop',
            }),
          );
          return {
            fullText: '',
            timeToFirstTokenMs,
            totalMs: Date.now() - started,
            streamed: false,
          };
        }
      }
    } catch (err) {
      this.logger.warn(
        JSON.stringify({
          event: 'voice.stream.llm_failed',
          callSessionId,
          message: err instanceof Error ? err.message.slice(0, 200) : 'error',
        }),
      );
      return { fullText: '', timeToFirstTokenMs: null, totalMs: Date.now() - started, streamed: false };
    }

    return {
      fullText: fullText.trim(),
      timeToFirstTokenMs,
      totalMs: Date.now() - started,
      usage,
      streamed: Boolean(fullText.trim()),
    };
  }
}
