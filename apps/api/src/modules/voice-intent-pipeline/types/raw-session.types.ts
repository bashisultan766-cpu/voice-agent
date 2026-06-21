/** Layer 1 — full caller text preserved in Redis (never truncated). */
export type RawVoiceTurn = {
  turnId: string;
  timestampMs: number;
  role: 'user' | 'assistant';
  rawText: string;
};

export type RawVoiceSession = {
  callSessionId: string;
  turns: RawVoiceTurn[];
  latestUserMessage: string;
  latestAssistantMessage?: string;
  updatedAt: number;
};

export const RAW_SESSION_REDIS_PREFIX = 'voice:raw-session:';
export const RAW_SESSION_TTL_SEC = 4 * 60 * 60;
