/**
 * Split assistant text into speakable streaming chunks (word boundaries).
 */

export function chunkTextForVoiceStream(text: string, maxLen = 100): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];

  const sentences = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [cleaned];
  const chunks: string[] = [];

  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s) continue;
    if (s.length <= maxLen) {
      chunks.push(s);
      continue;
    }
    const words = s.split(/\s+/);
    let buf = '';
    for (const w of words) {
      const next = buf ? `${buf} ${w}` : w;
      if (next.length > maxLen && buf) {
        chunks.push(buf);
        buf = w;
      } else {
        buf = next;
      }
    }
    if (buf) chunks.push(buf);
  }

  return chunks.length ? chunks : [cleaned];
}

/** First chunk sized for low time-to-first-audio. */
export function firstSpeakableChunk(text: string): string {
  const chunks = chunkTextForVoiceStream(text, 85);
  return chunks[0] ?? text.trim().slice(0, 120);
}
