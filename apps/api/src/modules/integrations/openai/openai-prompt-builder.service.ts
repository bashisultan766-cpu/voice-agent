import { Injectable } from '@nestjs/common';
import { VoiceSessionContext } from '../../calls/runtime/session-context.service';
import {
  buildAgentRuntimePrompt,
  promptInputFromVoiceSessionContext,
} from '../../calls/runtime/build-agent-runtime-prompt';

@Injectable()
export class OpenAIPromptBuilderService {
  build(ctx: VoiceSessionContext): string {
    const step =
      ctx.metadata && typeof ctx.metadata === 'object' && !Array.isArray(ctx.metadata)
        ? (ctx.metadata as Record<string, unknown>).orderState
        : null;
    const checkoutStep = typeof step === 'string' && step.trim() ? step.trim() : null;
    return buildAgentRuntimePrompt(promptInputFromVoiceSessionContext(ctx), { checkoutStep });
  }
}
