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

  build(ctx: VoiceSessionContext): string {
    const step =
      ctx.metadata && typeof ctx.metadata === 'object' && !Array.isArray(ctx.metadata)
        ? (ctx.metadata as Record<string, unknown>).orderState
        : null;
    const checkoutStep = typeof step === 'string' && step.trim() ? step.trim() : null;
    const personality = (ctx.agent.personality ?? null) as VoicePersonalityTraits | null;
    const enabledTools = this.toolRegistry.resolveEnabledToolNames({
      enabledTools: ctx.agent.enabledTools,
      toolPermissions: ctx.agent.toolPermissions,
    });
    return buildAgentRuntimePrompt(promptInputFromVoiceSessionContext(ctx), {
      checkoutStep,
      personality,
      enabledTools,
    });
  }
}
