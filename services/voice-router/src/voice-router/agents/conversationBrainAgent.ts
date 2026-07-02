import OpenAI from "openai";
import { getConfig } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { CONVERSATION_BRAIN_SYSTEM_PROMPT } from "./conversationBrainPrompt.js";
import {
  appendAssistantMessage,
  appendUserMessage,
  getOrCreateMemory,
  setInferredIntent,
  type CallMemory,
} from "../../memory/callMemoryStore.js";

const ROBOTIC_PHRASES = [
  /i didn'?t catch/i,
  /i didn'?t understand/i,
  /invalid input/i,
  /please provide (your )?order number/i,
  /valid order number/i,
];

let client: OpenAI | null = null;

function getClient(): OpenAI | null {
  const apiKey = getConfig().OPENAI_API_KEY;
  if (!apiKey) return null;
  if (!client) {
    client = new OpenAI({ apiKey, timeout: getConfig().OPENAI_TIMEOUT_MS });
  }
  return client;
}

export interface ConversationBrainInput {
  callSid: string;
  userMessage: string;
  inferredIntent?: string;
}

export async function generateConversationResponse(
  input: ConversationBrainInput,
): Promise<string> {
  const memory = getOrCreateMemory(input.callSid);
  appendUserMessage(memory, input.userMessage);
  if (input.inferredIntent) {
    setInferredIntent(memory, input.inferredIntent);
  }

  const openai = getClient();
  if (!openai) {
    const fallback = shapeBrainResponse(softFallback(input.userMessage), memory);
    appendAssistantMessage(memory, fallback);
    return fallback;
  }

  try {
    const response = await openai.chat.completions.create({
      model: getConfig().CONVERSATION_BRAIN_MODEL,
      temperature: 0.85,
      max_tokens: 120,
      messages: buildMessages(memory),
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? "";
    const shaped = shapeBrainResponse(raw || softFallback(input.userMessage), memory);
    appendAssistantMessage(memory, shaped);
    return shaped;
  } catch (err) {
    logger.warn("router_conversation_brain_failed", {
      callSid: input.callSid.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
    const fallback = shapeBrainResponse(softFallback(input.userMessage), memory);
    appendAssistantMessage(memory, fallback);
    return fallback;
  }
}

function buildMessages(memory: CallMemory): OpenAI.Chat.ChatCompletionMessageParam[] {
  const antiRepeat =
    memory.recentAssistantPhrases.length > 0
      ? `\n\nDo NOT repeat:\n${memory.recentAssistantPhrases.slice(0, 4).join("\n")}`
      : "";

  const intentNote = memory.inferredIntent
    ? `\n\nInferred caller intent: ${memory.inferredIntent}`
    : "";

  const history = memory.messages.slice(0, -1).map((m: { role: "user" | "assistant"; content: string }) => ({
    role: m.role,
    content: m.content,
  }));
  const latest = memory.messages[memory.messages.length - 1];

  return [
    { role: "system", content: `${CONVERSATION_BRAIN_SYSTEM_PROMPT}${intentNote}${antiRepeat}` },
    ...history,
    { role: "user", content: latest?.content ?? "" },
  ];
}

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
  if (/^(ok|okay|sure|yeah)\b/.test(lower)) {
    return "Sure — just tell me what you need.";
  }
  if (!lower) {
    return "No worries — whenever you're ready, I'm here to help.";
  }
  return "I'm here to help with your SureShot Books order. What would you like to know?";
}
