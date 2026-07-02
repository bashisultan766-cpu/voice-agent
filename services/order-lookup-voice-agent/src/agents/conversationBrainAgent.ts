import OpenAI from "openai";
import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { CONVERSATION_BRAIN_SYSTEM_PROMPT } from "./conversationBrainPrompt.js";
import {
  appendAssistantMessage,
  appendUserMessage,
  getOrCreateMemory,
  setInferredIntent,
  type CallMemory,
} from "../memory/callMemoryStore.js";

const ROBOTIC_PHRASES = [
  /i didn'?t catch/i,
  /i didn'?t understand/i,
  /invalid input/i,
  /please provide (your )?order number/i,
  /valid order number/i,
  /i didn'?t hear anything/i,
];

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: getConfig().OPENAI_API_KEY,
      timeout: getConfig().OPENAI_TIMEOUT_MS,
    });
  }
  return client;
}

export interface ConversationBrainInput {
  callSid: string;
  userMessage: string;
  inferredIntent?: string;
  /** Extra hint for the model (e.g. caller tried an order number). */
  situationalHint?: string;
}

export async function generateConversationResponse(
  input: ConversationBrainInput,
): Promise<string> {
  const memory = getOrCreateMemory(input.callSid);
  appendUserMessage(memory, input.userMessage);
  if (input.inferredIntent) {
    setInferredIntent(memory, input.inferredIntent);
  }

  try {
    const response = await getClient().chat.completions.create({
      model: getConfig().CONVERSATION_BRAIN_MODEL,
      temperature: 0.85,
      max_tokens: 120,
      messages: buildMessages(memory, input.situationalHint),
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? "";
    const shaped = shapeBrainResponse(raw || softFallback(input.userMessage), memory);
    appendAssistantMessage(memory, shaped);
    return shaped;
  } catch (err) {
    logger.warn("conversation_brain_failed", {
      callSid: input.callSid.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
    const fallback = shapeBrainResponse(softFallback(input.userMessage), memory);
    appendAssistantMessage(memory, fallback);
    return fallback;
  }
}

function buildMessages(memory: CallMemory, situationalHint?: string): OpenAI.Chat.ChatCompletionMessageParam[] {
  const antiRepeat =
    memory.recentAssistantPhrases.length > 0
      ? `\n\nPhrases you already used this call — do NOT repeat:\n${memory.recentAssistantPhrases
          .slice(0, 4)
          .map((p) => `- ${p}`)
          .join("\n")}`
      : "";

  const intentNote = memory.inferredIntent
    ? `\n\nInferred caller intent: ${memory.inferredIntent}`
    : "";

  const hint = situationalHint ? `\n\nSituational hint: ${situationalHint}` : "";

  const system = `${CONVERSATION_BRAIN_SYSTEM_PROMPT}${intentNote}${antiRepeat}${hint}`;

  const history = memory.messages.slice(0, -1).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const latest = memory.messages[memory.messages.length - 1];

  return [
    { role: "system", content: system },
    ...history,
    { role: "user", content: latest?.content ?? "" },
  ];
}

/** Enforce voice-friendly output and strip robotic phrasing. */
export function shapeBrainResponse(text: string, memory: CallMemory): string {
  let cleaned = text.replace(/\s+/g, " ").trim();

  for (const pattern of ROBOTIC_PHRASES) {
    if (pattern.test(cleaned)) {
      cleaned = softFallback(memory.messages[memory.messages.length - 1]?.content ?? "");
      break;
    }
  }

  const sentences = cleaned.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length > 2) {
    cleaned = sentences.slice(0, 2).join(" ");
  }

  const normalized = cleaned.toLowerCase();
  for (const prior of memory.recentAssistantPhrases) {
    if (prior.toLowerCase() === normalized) {
      return softFallback(memory.messages[memory.messages.length - 1]?.content ?? "");
    }
  }

  return cleaned || softFallback("");
}

export function softFallback(userMessage: string): string {
  const lower = userMessage.toLowerCase().trim();

  if (/\bhow are you\b/.test(lower)) {
    return "Hey! I'm doing great — how can I help you today?";
  }
  if (/^(hi|hello|hey)\b/.test(lower)) {
    return "Hi there! What can I help you with today?";
  }
  if (/\bwhat do you do\b/.test(lower)) {
    return "I help you track and manage your book orders. If you have an order number, I can check it instantly.";
  }
  if (/^(ok|okay|sure|yeah|yep)\b/.test(lower)) {
    return "Sure — just tell me what you need.";
  }
  if (!lower) {
    return "No worries — whenever you're ready, I'm here to help.";
  }

  return "I'm here to help with your SureShot Books order. What would you like to know?";
}
