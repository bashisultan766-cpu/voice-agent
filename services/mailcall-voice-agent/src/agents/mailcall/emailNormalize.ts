/**
 * Normalize spoken / typed email addresses and apply surgical token corrections.
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

/** Natural read-back for voice confirmation (never invent new spellings). */
export function speakEmailForConfirm(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!looksLikeEmail(normalized)) return normalized;

  const [local = "", domain = ""] = normalized.split("@");
  // Space digit runs from letters: bashisaab64 → bashisaab 64
  const localSpoken = local
    .replace(/([a-z])(\d)/gi, "$1 $2")
    .replace(/(\d)([a-z])/gi, "$1 $2")
    .replace(/[._+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const domainSpoken = domain.replace(/\./g, " dot ");
  return `${localSpoken} at ${domainSpoken}`;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }
  return dp[m]![n]!;
}

/** Extract letter-by-letter spelling: "S A A B" / "S-A-A-B" → "saab". */
export function extractLetterSpelling(utterance: string): string | null {
  const cleaned = utterance
    .toLowerCase()
    .replace(/\b(spell(?:ed|ing)?|letter|letters|as in)\b/g, " ")
    .trim();

  // Prefer dashed or spaced single letters of length 2–16
  const match = cleaned.match(
    /\b([a-z](?:\s*[-\u2013]\s*[a-z]|\s+[a-z]){1,15})\b/,
  );
  if (!match?.[1]) return null;
  const letters = match[1].split(/[\s\-\u2013]+/).filter((c) => /^[a-z]$/.test(c));
  if (letters.length < 2) return null;
  return letters.join("");
}

/**
 * Replace the closest substring in `haystack` with `correction` when edit distance is small.
 * Used so "Saub" → "Saab" patches only that token inside bashisaub64@….
 */
export function replaceClosestToken(haystack: string, correction: string): string | null {
  const h = haystack.toLowerCase();
  const c = correction.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!c || c.length < 2) return null;
  if (h.includes(c)) return null; // already correct

  let best: { start: number; end: number; dist: number } | null = null;
  const minLen = Math.max(2, c.length - 1);
  const maxLen = c.length + 1;

  for (let len = minLen; len <= maxLen; len++) {
    for (let i = 0; i + len <= h.length; i++) {
      const slice = h.slice(i, i + len);
      // Prefer alphabetic windows when correcting letters
      if (!/^[a-z0-9]+$/.test(slice)) continue;
      const dist = levenshtein(slice, c);
      const maxDist = c.length <= 3 ? 1 : 2;
      if (dist === 0 || dist > maxDist) continue;
      if (!best || dist < best.dist || (dist === best.dist && len === c.length)) {
        best = { start: i, end: i + len, dist };
      }
    }
  }

  if (!best) return null;
  return h.slice(0, best.start) + c + h.slice(best.end);
}

/**
 * Surgically patch a buffered email from a correction utterance.
 * Returns null when the utterance is not a usable correction.
 */
export function applyEmailTokenCorrection(
  currentEmail: string,
  utterance: string,
): string | null {
  const current = currentEmail.trim().toLowerCase();
  if (!looksLikeEmail(current)) return null;

  // Full re-speak of the address
  const full = normalizeSpokenEmail(utterance);
  if (looksLikeEmail(full) && full !== current) return full;
  if (looksLikeEmail(full) && full === current) return current;

  const [local = "", domain = ""] = current.split("@");
  const u = utterance.trim();

  // "change Saub to Saab" / "correct X to Y" / "replace X with Y"
  const pair =
    u.match(
      /\b(?:change|correct|fix|replace)\s+([a-z0-9]+)\s+(?:to|with|as)\s+([a-z0-9]+)\b/i,
    ) ||
    u.match(/\b([a-z0-9]+)\s+(?:to|→)\s+([a-z0-9]+)\b/i) ||
    u.match(/\bnot\s+([a-z0-9]+)[,.]?\s*(?:it'?s|its|but)?\s*([a-z0-9]+)\b/i);

  if (pair) {
    const from = pair[1]!.toLowerCase();
    const to = pair[2]!.toLowerCase();
    if (local.includes(from)) {
      const patched = `${local.replace(from, to)}@${domain}`;
      return looksLikeEmail(patched) ? patched : null;
    }
    const viaWindow = replaceClosestToken(local, to);
    if (viaWindow) {
      const patched = `${viaWindow}@${domain}`;
      return looksLikeEmail(patched) ? patched : null;
    }
  }

  // Letter spelling: "S A A B"
  const spelled = extractLetterSpelling(u);
  if (spelled) {
    const viaWindow = replaceClosestToken(local, spelled);
    if (viaWindow) {
      const patched = `${viaWindow}@${domain}`;
      return looksLikeEmail(patched) ? patched : null;
    }
  }

  // Single correction token (e.g. "Saab") — patch only the closest local substring
  const single = u
    .toLowerCase()
    .replace(
      /^(?:it(?:'s| is)|should be|spell(?:ed|ing)?(?: it)?(?: as)?)\s+/i,
      "",
    )
    .replace(/[^a-z0-9\s\-]/g, " ")
    .trim();

  // Ignore pure yes/no and fluff
  if (
    /^(yes|no|correct|right|wrong|nope|yep|yeah|ok|okay)$/i.test(single) ||
    single.split(/\s+/).length > 4
  ) {
    return null;
  }

  const token = single.replace(/[\s\-]+/g, "");
  if (/^[a-z0-9]{2,24}$/.test(token)) {
    const viaWindow = replaceClosestToken(local, token);
    if (viaWindow && viaWindow !== local) {
      const patched = `${viaWindow}@${domain}`;
      return looksLikeEmail(patched) ? patched : null;
    }
  }

  return null;
}
