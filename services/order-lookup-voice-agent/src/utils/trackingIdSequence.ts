/**
 * Raw tracking ID sequences — never parse as floats (prevents "20" → "2.0").
 */

/** Strip decimal artifacts and non-alphanumeric noise from tracking IDs. */
export function normalizeTrackingIdRawSequence(raw: string): string {
  let value = String(raw ?? "").trim();
  if (!value) return "";

  // Collapse mistaken decimal insertion between digits (e.g. "2.0" → "20").
  value = value.replace(/(\d)\.(\d)/g, "$1$2");

  // Remove currency / unit suffixes if STT glued them on.
  value = value.replace(/\s*(?:usd|dollars?)\b/gi, "");

  return value.replace(/[^\dA-Za-z-]/g, "").toUpperCase();
}

/** Speak tracking as a literal character sequence — no numeric math. */
export function trackingIdAsRawDigitSequence(raw: string): string {
  return [...normalizeTrackingIdRawSequence(raw)].join("");
}
