import { Injectable } from '@nestjs/common';
import { RealtimeVoiceOrchestratorService } from '../orchestrator/realtime-voice-orchestrator.service';

/**
 * Bridge from legacy VoiceRuntimeService to the multi-agent orchestrator.
 * Enabled when REALTIME_MULTI_AGENT_ENABLED=true.
 */
@Injectable()
export class LegacyVoiceBridgeService {
  constructor(private readonly orchestrator: RealtimeVoiceOrchestratorService) {}

  isMultiAgentEnabled(): boolean {
    return this.orchestrator.isEnabled();
  }

  async processUtterance(
    callSessionId: string,
    text: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }> = [],
  ): Promise<{ reply: string; turnProof?: Record<string, unknown> }> {
    const result = await this.orchestrator.processUtterance(callSessionId, text, history);
    return { reply: result.reply, turnProof: result.turnProof };
  }
}
