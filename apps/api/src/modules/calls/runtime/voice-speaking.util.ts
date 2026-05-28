/**
 * Human-like voice output shaping: brevity, filler reduction, empathy without verbosity.
 */

import { sanitizeBannedVoicePhrases } from './professional-conversation-policy.util';

const FILLER_RE =
  /\b(uh+|um+|erm+|like,|you know,|basically,|actually,|so,)\s*/gi;
const MULTI_SPACE = /\s{2,}/g;

export type VoiceSpeakingOptions = {
  maxSentences?: number;
  maxChars?: number;
  stage?: string;
};

export function reduceFillers(text: string): string {
  return text.replace(FILLER_RE, '').replace(MULTI_SPACE, ' ').trim();
}

export function truncateForVoice(text: string, opts?: VoiceSpeakingOptions): string {
  const maxSentences = opts?.maxSentences ?? 3;
  const maxChars = opts?.maxChars ?? 320;
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

export function polishVoiceReply(text: string, opts?: VoiceSpeakingOptions): string {
  let t = sanitizeBannedVoicePhrases(reduceFillers(text));
  t = truncateForVoice(t, opts);
  return sanitizeBannedVoicePhrases(t);
}

/** Short confirmation phrases — avoid repeating the same lead twice in a row. */
export function buildBriefConfirmation(what: string, lastLead?: string | null): string {
  const leads = ['Got it.', 'Perfect.', 'Sure.'];
  const lead = leads.find((l) => l !== lastLead) ?? 'Got it.';
  const core = what.trim().endsWith('.') ? what.trim() : `${what.trim()}.`;
  return `${lead} ${core}`;
}

export function empathyPrefix(tone: 'neutral' | 'frustrated' | 'excited'): string | null {
  if (tone === 'frustrated') return 'I understand—that can be frustrating.';
  if (tone === 'excited') return 'Great choice.';
  return null;
}
