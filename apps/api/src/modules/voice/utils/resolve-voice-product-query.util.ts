/** Query string fields ElevenLabs may send on GET /api/voice/get-product */
export type VoiceProductQueryInput = {
  query?: string;
  isbn?: string;
  sku?: string;
  search?: string;
  q?: string;
};

/**
 * Resolve catalog search text from GET query params (supports isbn/sku aliases).
 */
export function resolveVoiceProductQuery(input: VoiceProductQueryInput): string | null {
  const candidates = [input.query, input.isbn, input.sku, input.search, input.q];
  for (const raw of candidates) {
    const trimmed = raw?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}
