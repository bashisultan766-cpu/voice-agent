/**
 * Domain guard — detects out-of-bookstore questions and builds Polite Pivot speech.
 * Backs up the system prompt so the agent never answers like a general chatbot.
 */

const BOOKSTORE_INTENT_RE =
  /\b(order|orders|book|books|isbn|title|catalog|shoshan|refund|track(?:ing)?|ship(?:ping)?|buy|purchase|cart|inmate|prison|magazine|newspaper|availability|stock|price|number\s*#?\d)\b/i;

const OUT_OF_DOMAIN_RE =
  /\b(recipe|recipes|cook(?!book)|stream(?:ing)?|live\s+stream|how\s+do\s+i\s+watch|watch\s+live|football|cricket|basketball|sports?\s+score|president|prime\s+minister|weather|capital\s+of|stock\s+market|crypto|bitcoin|medical\s+advice|legal\s+advice|life\s+advice|who\s+is\s+the|what\s+is\s+the\s+capital)\b/i;

const SPORT_TOPIC_RE =
  /\b(cricket|football|basketball|soccer|baseball|tennis|golf|rugby|hockey|volleyball)\b/i;

/** True when the utterance is clearly outside Shoshan's bookstore scope. */
export function isOutOfDomainQuestion(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  if (BOOKSTORE_INTENT_RE.test(text)) return false;
  return OUT_OF_DOMAIN_RE.test(text);
}

/** Extract the caller's specific topic for a dynamic book-search pivot. */
export function extractPivotTopic(message: string): string {
  const lower = message.toLowerCase();

  const sport = lower.match(SPORT_TOPIC_RE);
  if (sport?.[1]) return sport[1];

  if (/recipe|cook(?!book)/.test(lower)) return "cooking";
  if (/president|politic|government/.test(lower)) return "American history or politics";
  if (/weather/.test(lower)) return "weather and climate";
  if (/capital\s+of/.test(lower)) return "geography";

  return "that topic";
}

function isStreamingQuestion(message: string): boolean {
  return /stream(?:ing)?|watch\s+live|how\s+do\s+i\s+watch|live\s+stream|\bwatch\b/i.test(
    message.toLowerCase(),
  );
}

function isRecipeQuestion(message: string): boolean {
  return /recipe|cook(?!book)/i.test(message);
}

function isGeneralKnowledgeQuestion(message: string): boolean {
  return /president|who\s+is\s+the|what\s+is\s+the\s+capital|prime\s+minister/i.test(message);
}

/**
 * Polite Pivot — refuse the general question, offer a catalog search on the user's topic.
 * @param topic — optional override; defaults to {@link extractPivotTopic}(message)
 */
export function buildPolitePivotSpeech(message: string, topic?: string): string {
  const pivotTopic = (topic ?? extractPivotTopic(message)).trim() || "that topic";
  const lower = message.toLowerCase();

  if (isRecipeQuestion(lower)) {
    return "I apologize, but I don't have access to recipes. I can, however, help you find a fantastic cookbook! Do you have a specific type of cooking in mind?";
  }

  if (isGeneralKnowledgeQuestion(lower)) {
    return "I'm sorry, but as the Shoshan bookstore assistant, I can't answer general knowledge questions like that. I can, however, search our catalog for books about American history or politics. Would you like me to do that?";
  }

  if (isStreamingQuestion(lower)) {
    if (SPORT_TOPIC_RE.test(lower)) {
      return `I'm sorry, but as the Shoshan bookstore assistant, I can't help with watching ${pivotTopic}. I can, however, search our catalog for books about ${pivotTopic}. Would you like me to do that?`;
    }
    return `I'm sorry, but as the Shoshan bookstore assistant, I can't give you information on live streaming. I can, however, search our catalog for books about ${pivotTopic}. Would you like me to do that?`;
  }

  return `I'm sorry, but as the Shoshan bookstore assistant, I can't help with that. I can, however, search our catalog for books about ${pivotTopic}. Would you like me to do that?`;
}
