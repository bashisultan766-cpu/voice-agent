import { sanitizeBannedVoicePhrases } from './professional-conversation-policy.util';
import { sanitizeBookstoreVoicePhrases } from './book-sales-voice.util';
import { isDeterministicTransactionalReply } from './voice-email-capture.util';

const BANNED_REPLY_PATTERNS: RegExp[] = [
  /\blet me check\b/i,
  /\bthank you for asking\b/i,
  /\bgo ahead\b/i,
  /\bdropshipping\b/i,
  /\bdrop\s+shipping\b/i,
  /\bi am an ai\b/i,
  /\bi'?m an ai\b/i,
  /\bjust a moment\b/i,
  /\bone moment while i look\b/i,
  /\bone moment\b/i,
  /\bi got you\b/i,
  /\bsure thing\b/i,
];

export const BRAIN_REWRITE_USER_PROMPT =
  'Rewrite this for a professional bookstore phone agent. Remove robotic phrases. Keep it to one or two short sentences.';

export const BRAIN_CLEAN_FALLBACK_REPLY =
  "I'm here to help you find or order a book. What title or topic are you looking for?";

export function containsBannedVoicePhrase(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return BANNED_REPLY_PATTERNS.some((re) => re.test(t));
}

export function sanitizeBrainReply(text: string): string {
  return sanitizeBookstoreVoicePhrases(sanitizeBannedVoicePhrases(text.trim()));
}

/** Truncate for phone without adding template leads. */
export function truncateBrainReply(text: string, maxSentences = 3, maxChars = 320): string {
  let t = text.trim();
  if (!t) return t;
  const sentences = t.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [t];
  if (sentences.length > maxSentences) {
    t = sentences.slice(0, maxSentences).join(' ').trim();
  }
  if (t.length > maxChars) {
    t = `${t.slice(0, maxChars - 3).trim()}...`;
  }
  return t;
}

/**
 * Final TTS-safe reply: sanitize banned phrases; optionally regenerate via OpenAI.
 */
export async function finalizeBrainReply(
  reply: string,
  opts?: {
    regenerate?: (draft: string) => Promise<string | null>;
    skipRewrite?: boolean;
  },
): Promise<string> {
  let t = sanitizeBrainReply(reply);
  if (opts?.skipRewrite || isDeterministicTransactionalReply(t || reply)) {
    return truncateBrainReply(t || reply.trim(), 4);
  }
  if (t && !containsBannedVoicePhrase(t)) {
    return truncateBrainReply(t);
  }

  if (opts?.regenerate && (t || reply.trim())) {
    try {
      const regen = await opts.regenerate(t || reply.trim());
      if (regen?.trim()) {
        const cleaned = sanitizeBrainReply(regen);
        if (cleaned && !containsBannedVoicePhrase(cleaned)) {
          return truncateBrainReply(cleaned);
        }
      }
    } catch {
      /* use fallback below */
    }
  }

  const fallback = sanitizeBrainReply(t || reply);
  if (fallback && !containsBannedVoicePhrase(fallback)) {
    return truncateBrainReply(fallback);
  }
  return BRAIN_CLEAN_FALLBACK_REPLY;
}
