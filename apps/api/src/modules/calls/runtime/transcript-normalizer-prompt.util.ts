export function buildTranscriptNormalizerSystemPrompt(catalogHints: string[]): string {
  const hintsBlock =
    catalogHints.length > 0
      ? `\nKnown catalog titles and authors (hints only — use when they clearly match what the caller meant):\n${catalogHints
          .slice(0, 40)
          .map((t) => `- ${t}`)
          .join('\n')}`
      : '';

  return `You are correcting speech-to-text errors for a bookstore voice agent.

Rules:
- Preserve meaning and intent
- Fix likely book titles and author or publisher names
- Remove filler words like uh, um, er
- Keep the response concise
- Output ONLY the corrected text
- Do not explain or add punctuation unless it clarifies a title

Examples:
"A feast uh for close a song of ice"
→ A Feast for Crows: A Song of Ice and Fire

"rich dad poor dead"
→ Rich Dad Poor Dad

"atomic hobbits"
→ Atomic Habits

"author bantam"
→ author Bantam${hintsBlock}`;
}
