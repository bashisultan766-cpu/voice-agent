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
  greeting: 'Hello! How can I help?',
  salam: 'Wa alaikum salam. How can I help you today?',
  salamShort: 'Wa alaikum salam. How can I help?',
  howAreYou: "I'm doing great, thank you.",
  thanks: "You're welcome.",
  yes: 'Great. What would you like next?',
  no: 'No problem. What can I help with?',
  okay: 'Sounds good. How can I help?',
  goodbye: 'Goodbye. Have a great day.',
  checkoutIntro: "Perfect. I'll help you place the order.",
  paymentLinkSent: 'Your payment link has been sent successfully.',
  searchAck: PRODUCT_SEARCH_FAST_ACK,
  searchAckShort: 'Sure, let me check.',
  productCorrection: 'Got it — checking that title instead.',
  emailPrompt: 'Please tell me your email address.',
  emailSpell: 'Please spell your email one character at a time.',
  emailConfirm: 'Just to confirm, is that email correct?',
  thankYouOrder: "You're welcome. Thank you for your order.",
  repeat: 'Of course. What would you like me to repeat?',
  speakEnglish: "Sure, I'll speak in English. How can I help?",
  namaste: 'Namaste. How can I help you today?',
  oneMoment: 'One moment...',
  checking: 'Checking that for you...',
  verifying: 'Let me verify...',
} as const;

const INSTANT_GREETING_PATTERNS: RegExp[] = [
  /^(hi|hello|hey|howdy|yo|greetings)\b/i,
  /^good\s+(morning|afternoon|evening|day)\b/i,
  /^assalamu\s*alaikum/i,
  /^as\s*salamu\s*alaikum/i,
  /^salam\b/i,
  /^namaste\b/i,
];

const INSTANT_GOODBYE_PATTERNS: RegExp[] = [
  /^goodbye\b/i,
  /^bye\b/i,
  /^see you\b/i,
  /^talk to you later\b/i,
  /^have a (good|nice) (day|one)\b/i,
];

const INSTANT_SMALL_TALK_PATTERNS: RegExp[] = [
  /\bwhat\s+are\s+you\s+doing\b/i,
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
  ...INSTANT_GOODBYE_PATTERNS,
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
  | 'namaste'
  | 'goodbye';

export function classifyInstantReplyKind(text: string): InstantReplyKind | null {
  const t = norm(text.trim());
  if (!t) return null;
  if (/^assalamu\s*alaikum|^as\s*salamu\s*alaikum|^salam\b/i.test(t)) return 'assalamu_alaikum';
  if (/^namaste\b/i.test(t)) return 'namaste';
  if (/\bwhat\s+are\s+you\s+doing\b/.test(t)) return 'how_are_you';
  if (/\bhow\s+(are|r)\s+(you|u|ya)\b/.test(t)) return 'how_are_you';
  if (/\b(say\s+(it|that)\s+again|which\s+(one|1)\s+say|say\s+again)\b/i.test(t)) return 'repeat';
  if (/^(thanks|thank you|thx|ty)\b/i.test(t)) return 'thanks';
  if (/^(yes|yeah|yep|yup)\.?$/i.test(t)) return 'yes';
  if (/^(no|nope|nah)\.?$/i.test(t)) return 'no';
  if (/^(okay|ok)\.?$/i.test(t)) return 'okay';
  if (/\b(repeat|say that again|can you repeat)\b/i.test(t)) return 'repeat';
  if (/\b(speak english|english please)\b/i.test(t)) return 'speak_english';
  if (INSTANT_GOODBYE_PATTERNS.some((re) => re.test(t))) return 'goodbye';
  if (INSTANT_GREETING_PATTERNS.some((re) => re.test(t))) return 'greeting';
  return null;
}

const INSTANT_AUDIO_BY_KIND: Record<InstantReplyKind, string> = {
  greeting: VOICE_CACHED_PHRASES.greeting,
  how_are_you: VOICE_CACHED_PHRASES.howAreYou,
  thanks: VOICE_CACHED_PHRASES.thanks,
  yes: VOICE_CACHED_PHRASES.yes,
  no: VOICE_CACHED_PHRASES.no,
  okay: VOICE_CACHED_PHRASES.okay,
  repeat: VOICE_CACHED_PHRASES.repeat,
  speak_english: VOICE_CACHED_PHRASES.speakEnglish,
  assalamu_alaikum: VOICE_CACHED_PHRASES.salam,
  namaste: VOICE_CACHED_PHRASES.namaste,
  goodbye: VOICE_CACHED_PHRASES.goodbye,
};

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
      reply = VOICE_CACHED_PHRASES.thanks;
      break;
    case 'yes':
      reply = VOICE_CACHED_PHRASES.yes;
      break;
    case 'no':
      reply = VOICE_CACHED_PHRASES.no;
      break;
    case 'okay':
      reply = VOICE_CACHED_PHRASES.okay;
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
      reply = VOICE_CACHED_PHRASES.namaste;
      break;
    case 'goodbye':
      reply = VOICE_CACHED_PHRASES.goodbye;
      break;
    default:
      reply = VOICE_CACHED_PHRASES.greeting;
  }
  return shortenVoiceReply(reply, VOICE_WORD_LIMITS.simple);
}

/** Map instant reply to exact pre-cached audio phrase (cache key must match warm list). */
export function instantReplyAudioPhrase(text: string, storeName = 'SureShot Books'): string {
  void storeName;
  const kind = classifyInstantReplyKind(text);
  if (kind && INSTANT_AUDIO_BY_KIND[kind]) {
    return INSTANT_AUDIO_BY_KIND[kind];
  }
  return buildInstantReply(text, storeName);
}

/** Cap voice replies at maxWords for faster TTS. */
export function shortenVoiceReply(text: string, maxWords = 20): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text.trim();
  return `${words.slice(0, maxWords).join(' ')}.`;
}
