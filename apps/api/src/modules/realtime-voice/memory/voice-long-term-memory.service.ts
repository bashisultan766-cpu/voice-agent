import { Injectable } from '@nestjs/common';
import { CallMemoryService } from '../../calls/runtime/call-memory.service';
import type { CallConversationMemory } from '@bookstore-voice-agents/types';

/**
 * Long-term memory adapter — persists customer preferences, orders, email
 * via existing PostgreSQL call session metadata.
 */
@Injectable()
export class VoiceLongTermMemoryService {
  constructor(private readonly callMemory: CallMemoryService) {}

  async load(callSessionId: string): Promise<CallConversationMemory> {
    return this.callMemory.load(callSessionId);
  }

  async merge(
    callSessionId: string,
    patch: Partial<CallConversationMemory>,
  ): Promise<CallConversationMemory> {
    return this.callMemory.merge(callSessionId, patch);
  }

  summarizeForPrompt(memory: CallConversationMemory): string {
    return this.callMemory.summarizeForPrompt(memory);
  }
}
