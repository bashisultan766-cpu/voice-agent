/**
 * ConversationRelay prefers incremental `text` tokens; chunk on word boundaries for natural pacing.
 */
export function chunkTextForRelay(text: string, maxLen = 110): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];

  const words = cleaned.split(' ');
  const chunks: string[] = [];
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
  return chunks.length ? chunks : [cleaned];
}
