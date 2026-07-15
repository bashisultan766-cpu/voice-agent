/**
 * Normalize spoken / typed email addresses for PlaceOrder.
 * "mary dot smith at gmail dot com" → mary.smith@gmail.com
 */

export function normalizeSpokenEmail(raw: string): string {
  let s = String(raw ?? "").trim().toLowerCase();
  if (!s) return "";

  // Strip trailing verbal fluff
  s = s
    .replace(/\b(please|thanks|thank you|that's it|that is it|period|end)\b/gi, " ")
    .replace(/[,;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  s = s
    .replace(/\s+at\s+/gi, "@")
    .replace(/\s+dot\s+/gi, ".")
    .replace(/\s+underscore\s+/gi, "_")
    .replace(/\s+dash\s+/gi, "-")
    .replace(/\s+hyphen\s+/gi, "-");

  // Remove remaining spaces inside the address
  s = s.replace(/\s+/g, "");

  // Collapse duplicate separators
  s = s.replace(/\.+/g, ".").replace(/@+/g, "@");

  // Trim junk around edges
  s = s.replace(/^[^a-z0-9]+/, "").replace(/[^a-z0-9.]+$/i, "");

  return s;
}

export function looksLikeEmail(value: string): boolean {
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value);
}
