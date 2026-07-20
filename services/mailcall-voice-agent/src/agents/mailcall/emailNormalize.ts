/**
 * Natural spoken-email ingestion, phonetic spell-back, and surgical token correction.
 */

const DIGIT_WORDS: Record<string, string> = {
  zero: "0",
  oh: "0",
  o: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};

/**
 * Accept natural speech forms and normalize to user@domain.
 * Examples:
 * - "bashi sultan 766 at gmail.com"
 * - "bashi sultan at 766 at gmail.com" (extra "at" before digits)
 * - "mary.smith@gmail.com"
 */
export function normalizeSpokenEmail(raw: string): string {
  let s = String(raw ?? "").trim().toLowerCase();
  if (!s) return "";

  // Strip polite / confirmation fluff (keep the address content)
  s = s
    .replace(
      /^(?:my (?:email|address) is|the email is|email is|it(?:'s| is)|this is)\s+/i,
      "",
    )
    .replace(
      /\b(please|thanks|thank you|that's it|that is it|period|end|okay|ok)\b/gi,
      " ",
    )
    .replace(/[,;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Spoken digit words → digits
  s = s.replace(
    /\b(zero|oh|o|one|two|three|four|five|six|seven|eight|nine)\b/gi,
    (w) => DIGIT_WORDS[w.toLowerCase()] ?? w,
  );

  // Separator words first (before provider shortcuts)
  s = s
    .replace(/\s+underscore\s+/gi, "_")
    .replace(/\s+dash\s+/gi, "-")
    .replace(/\s+hyphen\s+/gi, "-")
    .replace(/\s+dot\s+/gi, ".")
    .replace(/\s+period\s+/gi, ".");

  // Common providers said without TLD — only when not already dotted
  s = s
    .replace(/\bgmail(?!\.[a-z])/gi, "gmail.com")
    .replace(/\byahoo(?!\.[a-z])/gi, "yahoo.com")
    .replace(/\bhotmail(?!\.[a-z])/gi, "hotmail.com")
    .replace(/\boutlook(?!\.[a-z])/gi, "outlook.com")
    .replace(/\bicloud(?!\.[a-z])/gi, "icloud.com")
    .replace(/\bprotonmail(?!\.[a-z])/gi, "protonmail.com");

  // Collapse accidental double TLDs from "gmail.com.com"
  s = s.replace(/\.(com|net|org|edu|io)\.\1\b/gi, ".$1");

  // If already looks like an email with @, collapse spaces around it
  if (s.includes("@")) {
    s = s.replace(/\s*@\s*/g, "@").replace(/\s+/g, "");
  } else if (/\bat\b/i.test(s)) {
    // "name 766 at gmail.com" or "name at 766 at gmail.com"
    // Prefer the LAST "at" before a domain-like token as the real @ separator
    const parts = s.split(/\bat\b/i).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const domainPart = parts[parts.length - 1]!;
      const localParts = parts.slice(0, -1);
      // Digits that were spoken after a mistaken "at" (e.g. "at 766") belong in local
      const localJoined = localParts.join("");
      s = `${localJoined}@${domainPart}`;
    }
    s = s.replace(/\s+/g, "");
  } else {
    // No "at": "name 766 gmail.com" → insert @ before known domain
    const domainMatch = s.match(
      /\b((?:gmail|yahoo|hotmail|outlook|icloud|protonmail|aol|mail)\.com)\s*$/i,
    );
    if (domainMatch) {
      const domain = domainMatch[1]!.toLowerCase();
      const local = s.slice(0, domainMatch.index).replace(/\s+/g, "");
      s = `${local}@${domain}`;
    } else {
      s = s.replace(/\s+/g, "");
    }
  }

  // Collapse duplicate separators / junk edges
  s = s.replace(/\.+/g, ".").replace(/@+/g, "@");
  s = s.replace(/^[^a-z0-9]+/, "").replace(/[^a-z0-9.]+$/i, "");

  // Fix "user@.gmail.com" / "user@gmailcom"
  s = s.replace(/@\.+/, "@");
  s = s.replace(/@(gmail|yahoo|hotmail|outlook|icloud)com$/i, "@$1.com");

  return s;
}

export function looksLikeEmail(value: string): boolean {
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value);
}

/**
 * Phonetic / character spell-back for voice confirmation.
 * bashisultan766@gmail.com → "B-A-S-H-I S-U-L-T-A-N 7-6-6 at gmail.com"
 */
export function speakEmailForConfirm(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!looksLikeEmail(normalized)) return normalized;

  const [local = "", domain = ""] = normalized.split("@");

  // Split local into letter runs and digit runs for clearer spell-back groups
  const chunks = local.match(/[a-z]+|\d+|[._+-]/g) ?? [local];
  const spokenChunks: string[] = [];

  for (const chunk of chunks) {
    if (/^[._+-]$/.test(chunk)) {
      if (chunk === ".") spokenChunks.push("dot");
      else if (chunk === "_") spokenChunks.push("underscore");
      else if (chunk === "-" || chunk === "+") spokenChunks.push("dash");
      continue;
    }
    if (/^\d+$/.test(chunk)) {
      spokenChunks.push(chunk.split("").join("-"));
      continue;
    }
    // Letter run: spell each letter; keep as one hyphenated group
    spokenChunks.push(chunk.toUpperCase().split("").join("-"));
  }

  // Domain spoken without literal periods (avoids TTS sentence splitters)
  const domainSpoken = domain.replace(/\./g, " dot ");
  return `${spokenChunks.join(" ")} at ${domainSpoken}`;
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

  const match = cleaned.match(
    /\b([a-z](?:\s*[-\u2013]\s*[a-z]|\s+[a-z]){1,20})\b/,
  );
  if (!match?.[1]) return null;
  const letters = match[1].split(/[\s\-\u2013]+/).filter((c) => /^[a-z]$/.test(c));
  if (letters.length < 2) return null;
  return letters.join("");
}

/**
 * Collapse a doubled letter once: "nn" → "n" in the closest match.
 * Handles "single N, not double N" / "one N not two".
 */
export function collapseDoubleLetter(local: string, letter: string): string | null {
  const L = letter.toLowerCase().replace(/[^a-z]/g, "");
  if (L.length !== 1) return null;
  const doubled = L + L;
  const idx = local.indexOf(doubled);
  if (idx === -1) return null;
  return local.slice(0, idx) + L + local.slice(idx + 2);
}

/** Expand a single letter to double where a lone letter sits in a name-like run. */
export function expandToDoubleLetter(local: string, letter: string): string | null {
  const L = letter.toLowerCase().replace(/[^a-z]/g, "");
  if (L.length !== 1) return null;
  // Prefer a single L that is not already doubled
  const re = new RegExp(`(?<!${L})${L}(?!${L})`, "i");
  if (!re.test(local)) return null;
  return local.replace(re, L + L);
}

export function replaceClosestToken(haystack: string, correction: string): string | null {
  const h = haystack.toLowerCase();
  const c = correction.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!c || c.length < 2) return null;
  if (h.includes(c)) return null;

  let best: { start: number; end: number; dist: number } | null = null;
  const minLen = Math.max(2, c.length - 1);
  const maxLen = c.length + 1;

  for (let len = minLen; len <= maxLen; len++) {
    for (let i = 0; i + len <= h.length; i++) {
      const slice = h.slice(i, i + len);
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
 * Surgically patch a buffered email from a natural correction utterance.
 */
export function applyEmailTokenCorrection(
  currentEmail: string,
  utterance: string,
): string | null {
  const current = currentEmail.trim().toLowerCase();
  if (!looksLikeEmail(current)) return null;

  const full = normalizeSpokenEmail(utterance);
  if (looksLikeEmail(full) && full !== current) return full;
  if (looksLikeEmail(full) && full === current) return current;

  const [local = "", domain = ""] = current.split("@");
  const u = utterance.trim();

  // "single N not double N" / "one N not two" / "not double N"
  const singleNotDouble = u.match(
    /\b(?:single|one|only one)\s+([a-z])\b|\b(?:not|no)\s+double\s+([a-z])\b|\bdouble\s+([a-z])\s+should\s+be\s+single\b/i,
  );
  if (singleNotDouble) {
    const letter = (singleNotDouble[1] || singleNotDouble[2] || singleNotDouble[3] || "").toLowerCase();
    const collapsed = collapseDoubleLetter(local, letter);
    if (collapsed) {
      const patched = `${collapsed}@${domain}`;
      return looksLikeEmail(patched) ? patched : null;
    }
  }

  // "double N" / "two N's" when they want to add a double
  const makeDouble = u.match(/\b(?:double|two)\s+([a-z])'?s?\b/i);
  if (makeDouble && !/\bnot\b/i.test(u)) {
    const letter = makeDouble[1]!.toLowerCase();
    const expanded = expandToDoubleLetter(local, letter);
    if (expanded) {
      const patched = `${expanded}@${domain}`;
      return looksLikeEmail(patched) ? patched : null;
    }
  }

  // "change Saub to Saab" / "correct X to Y"
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

  const spelled = extractLetterSpelling(u);
  if (spelled) {
    const viaWindow = replaceClosestToken(local, spelled);
    if (viaWindow) {
      const patched = `${viaWindow}@${domain}`;
      return looksLikeEmail(patched) ? patched : null;
    }
  }

  const single = u
    .toLowerCase()
    .replace(
      /^(?:it(?:'s| is)|should be|spell(?:ed|ing)?(?: it)?(?: as)?)\s+/i,
      "",
    )
    .replace(/[^a-z0-9\s\-]/g, " ")
    .trim();

  if (
    /^(yes|no|correct|right|wrong|nope|yep|yeah|ok|okay)$/i.test(single) ||
    single.split(/\s+/).length > 6
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
