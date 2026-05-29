/**
 * Deterministic instant replies — no OpenAI, tools, or Shopify on the hot path.
 */

export const PRODUCT_SEARCH_FAST_ACK = 'Sure, let me check that for you.';

/** Word limits for TTS latency (per response type). */
export const VOICE_WORD_LIMITS = {
  simple: 8,
  productAck: 7,
  checkoutPrompt: 15,
  productResult: 25,
} as const;

/** Canonical phrases pre-generated for ElevenLabs audio cache. */
export const VOICE_CACHED_PHRASES = {
  greeting: 'Hello, how can I help you today?',
  salam: 'Wa alaikum salam. How can I help you today?',
  howAreYou: "I'm doing great, thank you.",
  searchAck: PRODUCT_SEARCH_FAST_ACK,
  emailPrompt: 'Please tell me your email address.',
  emailSpell: 'Please spell your email one character at a time.',
  emailConfirm: 'Just to confirm, is that email correct?',
  thankYouOrder: "You're welcome. Thank you for your order.",
  repeat: 'Of course. What would you like me to repeat?',
  speakEnglish: "Sure, I'll speak in English. How can I help?",
} as const;

const INSTANT_GREETING_PATTERNS: RegExp[] = [
  /^(hi|hello|hey|howdy|yo|greetings)\b/i,
  /^good\s+(morning|afternoon|evening|day)\b/i,
  /^assalamu\s*alaikum/i,
  /^as\s*salamu\s*alaikum/i,
  /^salam\b/i,
  /^namaste\b/i,
];

const INSTANT_SMALL_TALK_PATTERNS: RegExp[] = [
  /\bhow\s+(are|r)\s+(you|u|ya)\b/i,
  /\bhow('?s| is)\s+(it|everything|things)\b/i,
  /^thanks?\b/i,
  /^thank\s+you\b/i,
  /^(yes|yeah|yep|yup|okay|ok|no|nope|nah)\.?$/i,
  /\bplease\s+repeat\b/i,
  /\bsay\s+that\s+again\b/i,
  /\bcan\s+you\s+repeat\b/i,
  /\bspeak\s+english\b/i,
  /\benglish\s+please\b/i,
];

function norm(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function hasCatalogSignal(t: string): boolean {
  return (
    /\b(do you have|have you got|book|books|title|author|isbn|sku|looking for|search|find)\b/i.test(
      t,
    ) || /\b\d{10,13}\b/.test(t)
  );
}

/** True when this turn should skip OpenAI entirely. */
export function shouldUseInstantReply(text: string, orderState = 'IDLE'): boolean {
  const raw = text.trim();
  if (!raw) return false;
  const t = norm(raw);
  if (hasCatalogSignal(t)) return false;

  const kind = classifyInstantReplyKind(raw);
  if (kind === 'yes' || kind === 'no' || kind === 'okay') {
    return orderState === 'IDLE';
  }

  for (const re of INSTANT_GREETING_PATTERNS) {
    if (re.test(t) && t.split(/\s+/).length <= 6) return true;
  }
  for (const re of INSTANT_SMALL_TALK_PATTERNS) {
    if (re.test(t)) return true;
  }
  return false;
}

export type InstantReplyKind =
  | 'greeting'
  | 'how_are_you'
  | 'thanks'
  | 'yes'
  | 'no'
  | 'okay'
  | 'repeat'
  | 'speak_english'
  | 'assalamu_alaikum'
  | 'namaste';

export function classifyInstantReplyKind(text: string): InstantReplyKind | null {
  const t = norm(text.trim());
  if (!t) return null;
  if (/^assalamu\s*alaikum|^as\s*salamu\s*alaikum|^salam\b/i.test(t)) return 'assalamu_alaikum';
  if (/^namaste\b/i.test(t)) return 'namaste';
  if (/\bhow\s+(are|r)\s+(you|u|ya)\b/.test(t)) return 'how_are_you';
  if (/^(thanks|thank you|thx|ty)\b/i.test(t)) return 'thanks';
  if (/^(yes|yeah|yep|yup)\.?$/i.test(t)) return 'yes';
  if (/^(no|nope|nah)\.?$/i.test(t)) return 'no';
  if (/^(okay|ok)\.?$/i.test(t)) return 'okay';
  if (/\b(repeat|say that again|can you repeat)\b/i.test(t)) return 'repeat';
  if (/\b(speak english|english please)\b/i.test(t)) return 'speak_english';
  if (INSTANT_GREETING_PATTERNS.some((re) => re.test(t))) return 'greeting';
  return null;
}

/** Deterministic reply text for instant intents. */
export function buildInstantReply(text: string, storeName = 'SureShot Books'): string {
  const kind = classifyInstantReplyKind(text);
  let reply: string;
  switch (kind) {
    case 'greeting':
      reply = VOICE_CACHED_PHRASES.greeting;
      break;
    case 'how_are_you':
      reply = VOICE_CACHED_PHRASES.howAreYou;
      break;
    case 'thanks':
      reply = "You're welcome. What else can I help?";
      break;
    case 'yes':
      reply = 'Great. What would you like next?';
      break;
    case 'no':
      reply = 'No problem. What can I help with?';
      break;
    case 'okay':
      reply = 'Sounds good. How can I help?';
      break;
    case 'repeat':
      reply = VOICE_CACHED_PHRASES.repeat;
      break;
    case 'speak_english':
      reply = VOICE_CACHED_PHRASES.speakEnglish;
      break;
    case 'assalamu_alaikum':
      reply = VOICE_CACHED_PHRASES.salam;
      break;
    case 'namaste':
      reply = 'Namaste. How can I help you today?';
      break;
    default:
      reply = VOICE_CACHED_PHRASES.greeting;
  }
  return shortenVoiceReply(reply, VOICE_WORD_LIMITS.simple);
}

/** Map instant reply to pre-cached audio phrase when available. */
export function instantReplyAudioPhrase(text: string): string {
  return buildInstantReply(text);
}

/** Cap voice replies at maxWords for faster TTS. */
export function shortenVoiceReply(text: string, maxWords = 20): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text.trim();
  return `${words.slice(0, maxWords).join(' ')}.`;
}
