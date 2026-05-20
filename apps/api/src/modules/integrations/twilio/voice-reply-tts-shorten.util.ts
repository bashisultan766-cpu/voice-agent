/** Max characters sent to ElevenLabs per reply (keeps MP3 small and synthesis fast). */
export const VOICE_REPLY_TTS_MAX_CHARS = 120;

/** Drop ElevenLabs <Play> and use <Say> if MP3 exceeds this size. */
export const VOICE_TTS_MAX_AUDIO_BYTES = 150 * 1024;

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function truncateAtWord(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  const slice = s.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace > Math.floor(maxLen * 0.55)) return slice.slice(0, lastSpace).trimEnd();
  return slice.trimEnd();
}

/**
 * When assistant text exceeds {@link VOICE_REPLY_TTS_MAX_CHARS}, keep the earliest complete
 * sentence(s) that fit, otherwise word-truncate with ellipsis — fast path for voice (no extra LLM).
 */
export function shortenReplyForVoiceTts(
  original: string,
  maxChars: number = VOICE_REPLY_TTS_MAX_CHARS,
): {
  text: string;
  reply_shortened: boolean;
  originalChars: number;
  finalChars: number;
} {
  const trimmed = collapseWhitespace(original);
  const originalChars = trimmed.length;
  if (!trimmed) {
    return { text: '', reply_shortened: false, originalChars: 0, finalChars: 0 };
  }
  if (originalChars <= maxChars) {
    return {
      text: trimmed,
      reply_shortened: false,
      originalChars,
      finalChars: originalChars,
    };
  }

  const parts = trimmed.split(/(?<=[.!?])\s+/).filter((p) => p.length > 0);
  let acc = '';
  for (const part of parts) {
    const next = acc ? `${acc} ${part}` : part;
    if (next.length <= maxChars) {
      acc = next;
      continue;
    }
    if (!acc) {
      const t = truncateAtWord(part, maxChars - 3);
      acc = `${t}...`;
    }
    break;
  }

  if (!acc) {
    const t = truncateAtWord(trimmed, maxChars - 3);
    acc = `${t}...`;
  }

  const text = acc.trim();
  return {
    text,
    reply_shortened: true,
    originalChars,
    finalChars: text.length,
  };
}
