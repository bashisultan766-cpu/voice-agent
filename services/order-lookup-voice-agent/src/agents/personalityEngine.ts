import type { CustomerEmotionalTone, CustomerMemory } from "../memory/customerMemoryStore.js";

export const BOOKSTORE_PERSONA = `You are a warm, intelligent bookstore assistant for SureShot Books. You help families of inmates in the USA find books, magazines, and newspapers. You are calm, helpful, and never robotic.`;

export function detectEmotionalTone(userMessage: string): CustomerEmotionalTone {
  const text = userMessage.toLowerCase();

  if (/\b(frustrated|frustrating|angry|upset|annoyed|ridiculous|terrible)\b/.test(text)) {
    return "frustrated";
  }
  if (/\b(confused|don't understand|not sure|what do you mean|lost)\b/.test(text)) {
    return "confused";
  }
  if (/\b(thank|thanks|great|awesome|perfect|wonderful)\b/.test(text)) {
    return "warm";
  }
  if (/\b(urgent|asap|quickly|right now|hurry)\b/.test(text)) {
    return "urgent";
  }
  return "neutral";
}

export function buildPersonalityPrompt(memory: CustomerMemory): string {
  const toneGuidance: Record<CustomerEmotionalTone, string> = {
    neutral: "Stay warm and approachable.",
    confused: "Be extra patient and guide step by step without sounding scripted.",
    frustrated: "Acknowledge their frustration briefly, then help calmly.",
    warm: "Match their positive energy briefly, then stay helpful.",
    urgent: "Be efficient and reassuring — get to the point fast.",
  };

  const genreHint =
    memory.preferredGenres.length > 0
      ? `Caller has shown interest in: ${memory.preferredGenres.slice(0, 3).join(", ")}.`
      : "";

  const historyHint =
    memory.lastSearchedProducts.length > 0
      ? `Recently discussed: ${memory.lastSearchedProducts.slice(0, 3).join("; ")}.`
      : "";

  const antiRepeat =
    memory.recentAssistantPhrases.length > 0
      ? `Do NOT repeat these phrases: ${memory.recentAssistantPhrases.slice(0, 4).join(" | ")}`
      : "";

  return [
    BOOKSTORE_PERSONA,
    toneGuidance[memory.emotionalTone],
    genreHint,
    historyHint,
    antiRepeat,
    "Keep responses to 1–2 short sentences for phone voice.",
    "If a product is not in the facts list, say exactly: I couldn't find it in the store right now.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function shapeVoiceResponse(text: string, memory: CustomerMemory): string {
  let cleaned = text.replace(/\s+/g, " ").trim();

  if (/couldn'?t find it in the store right now/i.test(cleaned)) {
    return cleaned;
  }

  const banned = [
    /invalid input/i,
    /please provide your order number/i,
  ];
  for (const pattern of banned) {
    if (pattern.test(cleaned)) {
      cleaned = "How can I help you today?";
      break;
    }
  }

  const sentences = cleaned.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length > 2) {
    cleaned = sentences.slice(0, 2).join(" ");
  }

  const lower = cleaned.toLowerCase();
  if (memory.recentAssistantPhrases.some((p) => p.toLowerCase() === lower)) {
    cleaned = "What else can I help you with?";
  }

  return cleaned;
}
