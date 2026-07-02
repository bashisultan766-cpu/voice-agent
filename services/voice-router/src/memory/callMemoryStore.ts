export interface CallMemoryMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface CallMemory {
  callSid: string;
  messages: CallMemoryMessage[];
  inferredIntent?: string;
  recentAssistantPhrases: string[];
  updatedAt: number;
}

const MAX_MESSAGES = 10;
const MAX_RECENT_PHRASES = 6;
const TTL_MS = 60 * 60 * 1000;

const memories = new Map<string, CallMemory>();

function purgeExpired(): void {
  const now = Date.now();
  for (const [sid, memory] of memories.entries()) {
    if (now - memory.updatedAt > TTL_MS) {
      memories.delete(sid);
    }
  }
}

export function getOrCreateMemory(callSid: string): CallMemory {
  purgeExpired();
  const existing = memories.get(callSid);
  if (existing) return existing;

  const memory: CallMemory = {
    callSid,
    messages: [],
    recentAssistantPhrases: [],
    updatedAt: Date.now(),
  };
  memories.set(callSid, memory);
  return memory;
}

export function appendUserMessage(memory: CallMemory, content: string): void {
  memory.messages.push({ role: "user", content, timestamp: Date.now() });
  trimMemory(memory);
  memory.updatedAt = Date.now();
}

export function appendAssistantMessage(memory: CallMemory, content: string): void {
  memory.messages.push({ role: "assistant", content, timestamp: Date.now() });
  memory.recentAssistantPhrases.unshift(content.trim());
  memory.recentAssistantPhrases = memory.recentAssistantPhrases.slice(0, MAX_RECENT_PHRASES);
  trimMemory(memory);
  memory.updatedAt = Date.now();
}

function trimMemory(memory: CallMemory): void {
  if (memory.messages.length > MAX_MESSAGES) {
    memory.messages = memory.messages.slice(-MAX_MESSAGES);
  }
}

export function setInferredIntent(memory: CallMemory, intent: string): void {
  memory.inferredIntent = intent;
  memory.updatedAt = Date.now();
}

export function clearCallMemory(callSid: string): void {
  memories.delete(callSid);
}

export function clearAllCallMemories(): void {
  memories.clear();
}
