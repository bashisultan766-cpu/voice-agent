import { Injectable } from '@nestjs/common';
import type { VoicePersonalityTraits } from '@bookstore-voice-agents/types';
import { VoiceSessionContext } from '../../calls/runtime/session-context.service';
import {
  buildAgentRuntimePrompt,
  promptInputFromVoiceSessionContext,
} from '../../calls/runtime/build-agent-runtime-prompt';
import { RuntimeToolRegistryService } from '../../tools/runtime-tool-registry.service';

@Injectable()
export class OpenAIPromptBuilderService {
  constructor(private readonly toolRegistry: RuntimeToolRegistryService) {}

  build(
    ctx: VoiceSessionContext,
    extras?: {
      conversationStage?: string | null;
      stageGuidance?: string | null;
      memorySummary?: string | null;
    },
  ): string {
    const meta =
      ctx.metadata && typeof ctx.metadata === 'object' && !Array.isArray(ctx.metadata)
        ? (ctx.metadata as Record<string, unknown>)
        : {};
    const step = meta.orderState;
    const checkoutStep = typeof step === 'string' && step.trim() ? step.trim() : null;
    const mem = meta.conversationMemory;
    const memorySummary =
      extras?.memorySummary ??
      (mem && typeof mem === 'object' ? this.summarizeMemory(mem as Record<string, unknown>) : null);
    const conversationStage =
      extras?.conversationStage ??
      (typeof (mem as Record<string, unknown> | undefined)?.conversationStage === 'string'
        ? String((mem as Record<string, unknown>).conversationStage)
        : null);
    const stageGuidance =
      extras?.stageGuidance ??
      (typeof meta.conversationStageGuidance === 'string' ? meta.conversationStageGuidance : null);
    const personality = (ctx.agent.personality ?? null) as VoicePersonalityTraits | null;
    const enabledTools = this.toolRegistry.resolveEnabledToolNames({
      enabledTools: ctx.agent.enabledTools,
      toolPermissions: ctx.agent.toolPermissions,
    });
    return buildAgentRuntimePrompt(promptInputFromVoiceSessionContext(ctx), {
      checkoutStep,
      conversationStage,
      stageGuidance,
      memorySummary,
      personality,
      enabledTools,
    });
  }

  private summarizeMemory(mem: Record<string, unknown>): string | null {
    const parts: string[] = [];
    if (typeof mem.customerName === 'string' && mem.customerName.trim()) {
      parts.push(`Customer: ${mem.customerName.trim()}`);
    }
    const genres = mem.preferredGenres;
    if (Array.isArray(genres) && genres.length) {
      parts.push(`Genres: ${genres.join(', ')}`);
    }
    const discussed = (mem.discussedProducts ?? mem.mentionedProducts) as unknown;
    if (Array.isArray(discussed) && discussed.length) {
      const titles = discussed
        .map((p) => (p && typeof p === 'object' && 'title' in p ? String((p as { title: string }).title) : ''))
        .filter(Boolean)
        .slice(-4);
      if (titles.length) parts.push(`Discussed: ${titles.join('; ')}`);
    }
    return parts.length ? parts.join('. ') : null;
  }
}
