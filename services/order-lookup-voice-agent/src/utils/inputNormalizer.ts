/**
 * STT order-number normalization — converts spoken / noisy transcripts into
 * strict Shopify query strings (e.g. "#21698", "#21698-F1").
 */

const ONES: Record<string, number> = {
  zero: 0,
  oh: 0,
  o: 0,
  one: 1,
  won: 1,
  two: 2,
  to: 2,
  too: 2,
  three: 3,
  tree: 3,
  four: 4,
  for: 4,
  fore: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  ate: 8,
  nine: 9,
};

const TEENS: Record<string, number> = {
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const FILLER_WORDS = new Set([
  "an",
  "and",
  "at",
  "for",
  "im",
  "is",
  "it",
  "its",
  "it's",
  "me",
  "my",
  "number",
  "of",
  "order",
  "please",
  "the",
  "this",
  "that",
  "what",
  "was",
  "would",
  "you",
  "your",
]);

/** Single-letter STT homophones in numeric order-ID context. */
const LETTER_DIGIT_CONFUSIONS: Record<string, string> = {
  o: "0",
  i: "1",
  l: "1",
  z: "2",
  a: "8",
  b: "8",
  g: "8",
  f: "5",
};

const SUFFIX_SEPARATOR_RE = /\b(dash|hyphen|minus|stroke|line)\b/i;

const FORMATTED_ORDER_RE = /^#?(\d{4,10})(?:-([A-Za-z0-9]{1,6}))?$/;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9#\s-]/gi, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function stripFillers(tokens: string[]): string[] {
  return tokens.filter((token) => !FILLER_WORDS.has(token));
}

function splitMainAndSuffix(text: string): { main: string; suffix: string | null } {
  const spokenSep = text.match(SUFFIX_SEPARATOR_RE);
  if (spokenSep?.index !== undefined) {
    return {
      main: text.slice(0, spokenSep.index),
      suffix: text.slice(spokenSep.index + spokenSep[0].length),
    };
  }

  const hyphenSep = text.match(/^(.+?)\s*-\s*(.+)$/);
  if (hyphenSep) {
    const left = hyphenSep[1].trim();
    const right = hyphenSep[2].trim();
    if (left && right && /[\da-z]/i.test(left) && /[\da-z]/i.test(right)) {
      return { main: left, suffix: right };
    }
  }

  return { main: text, suffix: null };
}

function consumeNumberChunk(
  tokens: string[],
  index: number,
): { value: string; nextIndex: number } {
  const token = tokens[index];
  if (!token) return { value: "", nextIndex: index + 1 };

  if (/^\d+$/.test(token)) {
    return { value: token, nextIndex: index + 1 };
  }

  if (token in TEENS) {
    return { value: String(TEENS[token]), nextIndex: index + 1 };
  }

  if (token in TENS) {
    const tensVal = TENS[token];
    const next = tokens[index + 1];
    if (next && next in ONES && !(next in TENS) && !(next in TEENS)) {
      return { value: String(tensVal + ONES[next]), nextIndex: index + 2 };
    }
    return { value: String(tensVal), nextIndex: index + 1 };
  }

  if (token in ONES) {
    return { value: String(ONES[token]), nextIndex: index + 1 };
  }

  if (token.length === 1) {
    const mapped = LETTER_DIGIT_CONFUSIONS[token];
    if (mapped) {
      return { value: mapped, nextIndex: index + 1 };
    }
  }

  return { value: "", nextIndex: index + 1 };
}

/** Collapse spoken or spaced digits into a continuous numeric string (no decimals). */
export function parseSpokenDigitSequence(text: string): string {
  const tokens = stripFillers(tokenize(text));
  let index = 0;
  let digits = "";

  while (index < tokens.length) {
    const chunk = consumeNumberChunk(tokens, index);
    digits += chunk.value;
    index = chunk.nextIndex;
  }

  return digits;
}

function parseSpokenSuffix(text: string): string {
  const tokens = stripFillers(tokenize(text));
  let suffix = "";

  for (const token of tokens) {
    if (/^[a-z]$/i.test(token)) {
      suffix += token.toUpperCase();
      continue;
    }
    if (/^\d+$/.test(token)) {
      suffix += token;
      continue;
    }
    if (token in ONES) {
      suffix += String(ONES[token]);
    }
  }

  return suffix.slice(0, 6);
}

function fromFormattedInput(raw: string): string | null {
  const compact = raw.trim().replace(/\s+/g, "").toUpperCase();
  const match = compact.match(FORMATTED_ORDER_RE);
  if (!match) return null;

  const base = match[1];
  const suffix = match[2];
  return suffix ? `#${base}-${suffix}` : `#${base}`;
}

/**
 * Normalize spoken or typed order numbers for Shopify lookup.
 * Handles word digits ("two one six"), compounds ("twenty one six ninety eight"),
 * spaced digits ("21 698"), and suffixes ("dash f one" → "-F1").
 */
export function normalizeOrderNumber(spokenInput: string): string {
  const trimmed = spokenInput.trim();
  if (!trimmed) return "";

  const preformatted = fromFormattedInput(trimmed);
  if (preformatted) return preformatted;

  const { main, suffix } = splitMainAndSuffix(trimmed);
  const baseDigits = parseSpokenDigitSequence(main);
  if (!baseDigits || baseDigits.length < 4) return "";

  if (suffix) {
    const suffixPart = parseSpokenSuffix(suffix);
    if (!suffixPart) return `#${baseDigits}`;
    return `#${baseDigits}-${suffixPart}`;
  }

  return `#${baseDigits}`;
}
