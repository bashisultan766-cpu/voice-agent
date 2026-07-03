/**
 * Domain guard — detects out-of-bookstore questions and builds Polite Pivot speech.
 * Backs up the system prompt so the agent never answers like a general chatbot.
 */

const BOOKSTORE_INTENT_RE =
  /\b(order|orders|book|books|isbn|title|catalog|shoshan|refund|track(?:ing)?|ship(?:ping)?|buy|purchase|cart|inmate|prison|magazine|newspaper|availability|stock|price|number\s*#?\d)\b/i;

const OUT_OF_DOMAIN_RE =
  /\b(recipe|recipes|cook(?!book)|stream(?:ing)?|live\s+stream|how\s+do\s+i\s+watch|watch\s+live|football|cricket|basketball|sports?\s+score|president|prime\s+minister|weather|capital\s+of|stock\s+market|crypto|bitcoin|medical\s+advice|legal\s+advice|life\s+advice|who\s+is\s+the|what\s+is\s+the\s+capital)\b/i;

/** True when the utterance is clearly outside Shoshan's bookstore scope. */
export function isOutOfDomainQuestion(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  if (BOOKSTORE_INTENT_RE.test(text)) return false;
  return OUT_OF_DOMAIN_RE.test(text);
}

function inferPivotBookTopic(message: string): string {
  const lower = message.toLowerCase();
  if (/football|soccer|cricket|basketball|sport/.test(lower)) return "sports";
  if (/recipe|cook(?!book)/.test(lower)) return "cooking";
  if (/president|politic|government/.test(lower)) return "American history or politics";
  if (/stream|watch\s+live/.test(lower)) return "that topic";
  return "that topic";
}

/**
 * Polite Pivot — refuse the general question, offer a catalog search on the topic.
 */
export function buildPolitePivotSpeech(message: string): string {
  const lower = message.toLowerCase();

  if (/recipe|cook(?!book)/.test(lower)) {
    return "I apologize, but I don't have access to recipes. I can, however, help you find a fantastic cookbook! Do you have a specific type of cooking in mind?";
  }

  if (/cricket/.test(lower)) {
    return "I'm sorry, but as the Shoshan bookstore assistant, I can't help with watching cricket. I can, however, search our catalog for books about cricket. Would you like me to do that?";
  }

  if (/football/.test(lower) && /stream|watch|how\s+do\s+i\s+watch|live/.test(lower)) {
    return "I'm sorry, but as the Shoshan bookstore assistant, I can't give you information on live streaming. However, if you are interested in football, I can certainly search our catalog for some great books about football. Would you like me to do that?";
  }

  if (/stream|watch\s+live|how\s+do\s+i\s+watch|live\s+stream/.test(lower)) {
    const topic = inferPivotBookTopic(message);
    return `I'm sorry, but as the Shoshan bookstore assistant, I can't give you information on live streaming. I can, however, search our catalog for books about ${topic}. Would you like me to do that?`;
  }

  if (/football/.test(lower)) {
    return "I'm sorry, but as the Shoshan bookstore assistant, I can't help with that. I can, however, search our catalog for books about football. Would you like me to do that?";
  }

  if (/president|who\s+is\s+the/.test(lower)) {
    return "I'm sorry, but as the Shoshan bookstore assistant, I can't answer general knowledge questions like that. I can, however, search our catalog for books about American history or politics. Would you like me to do that?";
  }

  const topic = inferPivotBookTopic(message);
  return `I'm sorry, but as the Shoshan bookstore assistant, I can't help with that. I can, however, search our catalog for books about ${topic}. Would you like me to do that?`;
}
