const ROMAN_MAP: Record<string, number> = {
  i: 1,
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9,
  x: 10,
  xi: 11,
  xii: 12,
};

const ORDINAL_WORDS: Record<string, number> = {
  one: 1,
  first: 1,
  two: 2,
  second: 2,
  three: 3,
  third: 3,
  four: 4,
  fourth: 4,
  five: 5,
  fifth: 5,
  six: 6,
  seventh: 7,
  seven: 7,
  eight: 8,
  ninth: 9,
  nine: 9,
  ten: 10,
};

export function normalizeBookTitleForSearch(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[''`]/g, '')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractVolumeNumber(text: string): number | null {
  const norm = normalizeBookTitleForSearch(text);
  const digit = norm.match(/\b(?:book|volume|vol|part|#)\s*(\d{1,2})\b/);
  if (digit) return Number(digit[1]);

  const roman = norm.match(/\b(i{1,3}|iv|vi{0,3}|ix|x{1,2}|xi{0,2})\b/i);
  if (roman && ROMAN_MAP[roman[1].toLowerCase()]) return ROMAN_MAP[roman[1].toLowerCase()];

  for (const [word, num] of Object.entries(ORDINAL_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(norm)) return num;
  }
  return null;
}

export function romanToArabicToken(token: string): string {
  const n = ROMAN_MAP[token.toLowerCase()];
  return n != null ? String(n) : token;
}

export function expandQueryTokens(query: string): string[] {
  const norm = normalizeBookTitleForSearch(query);
  const base = norm.split(/\s+/).filter((t) => t.length > 0);
  const expanded = [...base];
  for (const t of base) {
    const asNum = romanToArabicToken(t);
    if (asNum !== t) expanded.push(asNum);
  }
  const vol = extractVolumeNumber(query);
  if (vol != null) expanded.push(String(vol));
  return [...new Set(expanded)];
}

export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = dp[j]!;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + cost);
      prev = temp;
    }
  }
  return dp[b.length]!;
}

export function levenshteinSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const dist = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

export function tokenOverlapScore(queryTokens: string[], haystack: string): number {
  if (queryTokens.length === 0) return 0;
  const hits = queryTokens.filter((t) => haystack.includes(t)).length;
  return hits / queryTokens.length;
}
