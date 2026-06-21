/**
 * Compress assistant text for phone TTS: 1–2 short sentences, no filler.
 * Target ~70% fewer spoken characters vs raw LLM output.
 */

const GREETING_PREFIX =
  /^(hi there!?|hello!?|hey!?|good (morning|afternoon|evening)[!,.\s]*|thanks for calling[^.!?]*[.!?]\s*)/i;
const FILLER_RE =
  /\b(uh+|um+|erm+|like,|you know,|basically,|actually,|so,|well,|just to let you know,?|i wanted to (let you know|mention)|please note that)\s*/gi;
const REPETITIVE_LEAD =
  /^(sure[,!.\s]*|of course[,!.\s]*|absolutely[,!.\s]*|certainly[,!.\s]*|great[,!.\s]*|perfect[,!.\s]*)/i;
const MULTI_SPACE = /\s{2,}/g;

export type VoiceCompressOptions = {
  maxSentences?: number;
  maxChars?: number;
};

export function defaultVoiceCompressOptions(): VoiceCompressOptions {
  const maxSentences = Number(process.env.VOICE_TTS_MAX_SENTENCES);
  const maxChars = Number(process.env.VOICE_TTS_MAX_CHARS);
  return {
    maxSentences: Number.isFinite(maxSentences) && maxSentences > 0 ? maxSentences : 2,
    maxChars: Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 180,
  };
}

export function stripVoiceGreetings(text: string): string {
  let t = text.trim();
  for (let i = 0; i < 3; i++) {
    const next = t.replace(GREETING_PREFIX, '').trim();
    if (next === t) break;
    t = next;
  }
  return t;
}

export function removeVoiceFiller(text: string): string {
  return text.replace(FILLER_RE, '').replace(MULTI_SPACE, ' ').trim();
}

/** Keep first N complete sentences; hard-cap characters for telephony. */
export function truncateVoiceSentences(text: string, opts?: VoiceCompressOptions): string {
  const maxSentences = opts?.maxSentences ?? 2;
  const maxChars = opts?.maxChars ?? 180;
  const cleaned = text.replace(MULTI_SPACE, ' ').trim();
  if (!cleaned) return '';

  const sentences = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [cleaned];
  let out = sentences.slice(0, maxSentences).join(' ').trim();
  out = out.replace(MULTI_SPACE, ' ');
  if (out.length > maxChars) {
    const words = out.split(/\s+/);
    let buf = '';
    for (const w of words) {
      const next = buf ? `${buf} ${w}` : w;
      if (next.length > maxChars - 1) break;
      buf = next;
    }
    out = buf.endsWith('.') || buf.endsWith('!') || buf.endsWith('?') ? buf : `${buf}.`;
  }
  return out;
}

/** Primary entry: minimal natural speech for ElevenLabs / Twilio Say. */
export function compressForVoice(text: string, opts?: VoiceCompressOptions): string {
  const merged = { ...defaultVoiceCompressOptions(), ...opts };
  let t = stripVoiceGreetings(text);
  t = removeVoiceFiller(t);
  t = t.replace(REPETITIVE_LEAD, '').trim();
  t = truncateVoiceSentences(t, merged);
  if (!t && text.trim()) {
    t = truncateVoiceSentences(removeVoiceFiller(text.trim()), merged);
  }
  return t.replace(MULTI_SPACE, ' ').trim();
}
