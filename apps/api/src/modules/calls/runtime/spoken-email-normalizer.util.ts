/**
 * Spoken email normalization — no imports from checkout/language modules (avoids circular deps).
 */

export const VOICE_EMAIL_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

/** Telephony spelling capture requires ≥0.92 before validation/checkout. */
export const EMAIL_CAPTURE_MIN_CONFIDENCE = 0.92;

export type EmailCaptureMode = 'normal' | 'spelling';

const NUMBER_WORDS: Record<string, string> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
};

export const DIGIT_TO_WORD: Record<string, string> = Object.fromEntries(
  Object.entries(NUMBER_WORDS).map(([word, digit]) => [digit, word]),
);

/** NATO / common phonetic alphabet → letter */
export const PHONETIC_TO_LETTER: Record<string, string> = {
  alpha: 'a',
  apple: 'a',
  boy: 'b',
  bravo: 'b',
  cat: 'c',
  charlie: 'c',
  dog: 'd',
  delta: 'd',
  echo: 'e',
  elephant: 'e',
  fish: 'f',
  foxtrot: 'f',
  golf: 'g',
  goat: 'g',
  hotel: 'h',
  india: 'i',
  joker: 'j',
  juliet: 'j',
  king: 'k',
  kilo: 'k',
  lima: 'l',
  lion: 'l',
  mike: 'm',
  mother: 'm',
  november: 'n',
  orange: 'o',
  oscar: 'o',
  papa: 'p',
  peter: 'p',
  quebec: 'q',
  queen: 'q',
  romeo: 'r',
  rabbit: 'r',
  sierra: 's',
  sugar: 's',
  tango: 't',
  tiger: 't',
  uniform: 'u',
  umbrella: 'u',
  victor: 'v',
  whiskey: 'w',
  xray: 'x',
  yankee: 'y',
  yellow: 'y',
  zebra: 'z',
  zulu: 'z',
};

const SPELLING_FILLER = new Set([
  'um',
  'uh',
  'like',
  'please',
  'my',
  'email',
  'is',
  'the',
  'okay',
  'ok',
  'yeah',
  'yes',
  'no',
  'so',
  'and',
  'it',
  'its',
  "it's",
]);

const FILLER_WORDS =
  /\b(um|uh|like|please|my|email|is|the|a|an|okay|ok|yeah|yes|no)\b/gi;

export function parseDoubleTripleDigits(text: string): string {
  const tokens = text.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    const afterDouble = tokens[i + 2];
    if (NUMBER_WORDS[t] && next === 'double' && afterDouble && NUMBER_WORDS[afterDouble]) {
      const d = NUMBER_WORDS[afterDouble];
      out.push(NUMBER_WORDS[t] + d + d);
      i += 2;
      continue;
    }
    if (t === 'double' && next && NUMBER_WORDS[next]) {
      const d = NUMBER_WORDS[next];
      out.push(d + d);
      i += 1;
      continue;
    }
    if (t === 'triple' && next && NUMBER_WORDS[next]) {
      const d = NUMBER_WORDS[next];
      out.push(d + d + d);
      i += 1;
      continue;
    }
    out.push(t);
  }
  return out.join(' ');
}

export function parseDigitWords(text: string): string {
  let normalized = text;
  for (const [word, digit] of Object.entries(NUMBER_WORDS)) {
    normalized = normalized.replace(new RegExp(`\\b${word}\\b`, 'g'), digit);
  }
  return normalized;
}

/** Expand "b for boy", "a for apple", and standalone phonetic words. */
export function expandPhoneticSpelling(text: string): string {
  let s = text.toLowerCase().replace(/[,;]/g, ' ');
  s = s.replace(/\b([a-z])\s+for\s+[a-z]+\b/gi, '$1');
  for (const [word, letter] of Object.entries(PHONETIC_TO_LETTER)) {
    s = s.replace(new RegExp(`\\b${word}\\b`, 'gi'), ` ${letter} `);
  }
  return s.replace(/\s+/g, ' ').trim();
}

function preprocessSpokenEmailInput(email: string): string {
  const trimmed = expandPhoneticSpelling(email.trim().toLowerCase());
  if (trimmed.includes('@')) {
    return trimmed;
  }
  return trimmed
    .replace(/\bat the rate\b/g, '<<ATTHERATE>>')
    .replace(/\bat sign\b/g, '<<ATSIGN>>')
    .replace(FILLER_WORDS, ' ')
    .replace(/[,.]/g, ' ')
    .replace(/<<attherate>>/gi, 'at the rate')
    .replace(/<<atsign>>/gi, 'at sign');
}

function tokenToChar(tok: string): string | null {
  if (!tok) return null;
  if (SPELLING_FILLER.has(tok)) return null;
  if (tok.length === 1 && /[a-z0-9]/.test(tok)) return tok;
  if (NUMBER_WORDS[tok]) return NUMBER_WORDS[tok];
  if (PHONETIC_TO_LETTER[tok]) return PHONETIC_TO_LETTER[tok];
  if (/^\d+$/.test(tok)) return tok;
  return null;
}

/** Parse spaced single-letter stream: "b a s h i r ... at gmail dot com". */
export function parseEmailTokenStream(text: string): { email: string | null; tokens: string[] } {
  const trimmed = expandPhoneticSpelling(text.trim().toLowerCase());
  const atMatch = trimmed.match(/\b(at the rate|at sign|at)\b/);
  if (!atMatch || atMatch.index == null || atMatch.index < 1) {
    return { email: null, tokens: [] };
  }

  const localRaw = trimmed.slice(0, atMatch.index);
  const domainRaw = trimmed
    .slice(atMatch.index)
    .replace(/\bat the rate\b/g, '')
    .replace(/\bat sign\b/g, '')
    .replace(/\bat\b/g, '');

  const localTokens = parseDigitWords(parseDoubleTripleDigits(localRaw))
    .split(/\s+/)
    .filter(Boolean);
  const domainTokens = parseDigitWords(parseDoubleTripleDigits(domainRaw))
    .replace(/\bdot\b/g, ' . ')
    .replace(/\bperiod\b/g, ' . ')
    .split(/\s+/)
    .filter(Boolean);

  const parsedLocal: string[] = [];
  for (const tok of localTokens) {
    const ch = tokenToChar(tok);
    if (ch) {
      parsedLocal.push(ch);
      continue;
    }
    if (
      /^[a-z0-9]{2,}$/i.test(tok) &&
      !['gmail', 'yahoo', 'hotmail', 'outlook', 'dot', 'com', 'org', 'net'].includes(tok.toLowerCase())
    ) {
      parsedLocal.push(tok.toLowerCase());
    }
  }

  const parsedDomain: string[] = [];
  for (const tok of domainTokens) {
    if (tok === '.') {
      parsedDomain.push('.');
      continue;
    }
    const ch = tokenToChar(tok);
    if (ch) parsedDomain.push(ch);
    else if (['gmail', 'yahoo', 'hotmail', 'outlook', 'icloud', 'proton', 'live'].includes(tok)) {
      parsedDomain.push(tok);
    } else if (['com', 'org', 'net', 'edu', 'co', 'uk', 'pk', 'io'].includes(tok)) {
      parsedDomain.push(tok);
    } else if (
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(tok) &&
      !['at', 'dot', 'period'].includes(tok.toLowerCase())
    ) {
      parsedDomain.push(tok.toLowerCase());
    }
  }

  const local = parsedLocal.join('');
  let domain = parsedDomain.join('').replace(/\s+/g, '');
  domain = domain.replace(/\.+/g, '.').replace(/^\./, '');
  if (!local || !domain.includes('.')) {
    return { email: null, tokens: [...localTokens, 'at', ...domainTokens] };
  }
  return { email: `${local}@${domain}`, tokens: [...localTokens, 'at', ...domainTokens] };
}

export function parseLetterByLetterEmail(text: string): string | null {
  const stream = parseEmailTokenStream(text);
  if (stream.email) return stream.email;

  const trimmed = expandPhoneticSpelling(text.trim().toLowerCase());
  if (!/\b(at the rate|at sign|at)\b/.test(trimmed)) return null;
  const atIdx = trimmed.search(/\b(at the rate|at sign|at)\b/);
  if (atIdx < 1) return null;
  const localRaw = trimmed.slice(0, atIdx).replace(FILLER_WORDS, ' ').replace(/[,.]/g, ' ');
  const domainRaw = trimmed
    .slice(atIdx)
    .replace(/\bat the rate\b/g, '')
    .replace(/\bat sign\b/g, '')
    .replace(/\bat\b/g, '')
    .replace(/\bdot\b/g, '.')
    .replace(/\bperiod\b/g, '.');
  const local = parseDigitWords(parseDoubleTripleDigits(localRaw)).replace(/\s+/g, '');
  const domain = parseDigitWords(parseDoubleTripleDigits(domainRaw.replace(/\s+/g, '')));
  if (!local || !domain.includes('.')) return null;
  return `${local}@${domain.replace(/\s+/g, '')}`;
}

export function normalizeSpokenEmail(email: string): string {
  const cleaned = preprocessSpokenEmailInput(email);
  if (!cleaned) return cleaned;

  let normalized = parseDoubleTripleDigits(cleaned)
    .replace(/\bat the rate\b/g, '@')
    .replace(/\bat sign\b/g, '@')
    .replace(/\bat\b/g, '@')
    .replace(/\bdot\b/g, '.')
    .replace(/\bperiod\b/g, '.');

  normalized = parseDigitWords(normalized);
  return normalized.replace(/\s+/g, '');
}

export type EmailCaptureResult = {
  email: string | null;
  confidence: number;
  mode: EmailCaptureMode;
  parseMethod: string;
  tokenStream: string[];
};

export function scoreEmailCaptureConfidence(
  email: string | null,
  parseMethod: string,
  tokenStream: string[],
): number {
  if (!email || !VOICE_EMAIL_REGEX.test(email)) return 0;
  let score = 0.72;
  if (parseMethod === 'direct') score = 0.96;
  else if (parseMethod === 'token_stream') score = 0.9;
  else if (parseMethod === 'phonetic_spelling') score = 0.88;
  else if (parseMethod === 'spoken_normalize') score = 0.84;
  else if (parseMethod === 'letter_by_letter') score = 0.86;

  const [local, domain] = email.split('@');
  if (local && local.length >= 3) score += 0.04;
  if (domain && domain.includes('.') && domain.split('.').pop()!.length >= 2) score += 0.06;

  if (tokenStream.length > 0) {
    const unknown = tokenStream.filter(
      (t) => !tokenToChar(t) && !['at', 'dot', 'gmail', 'com', 'org'].includes(t),
    ).length;
    score -= (unknown / Math.max(tokenStream.length, 1)) * 0.2;
  }

  return Math.min(1, Math.max(0, score));
}

/** Dedicated capture path for voice spelling mode. */
export function captureEmailFromVoice(
  text: string,
  options?: { mode?: EmailCaptureMode },
): EmailCaptureResult {
  const mode = options?.mode ?? 'normal';
  const trimmed = text.trim();
  if (!trimmed) {
    return { email: null, confidence: 0, mode, parseMethod: 'empty', tokenStream: [] };
  }

  const direct = trimmed.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (direct) {
    const email = direct[0].toLowerCase();
    return {
      email,
      confidence: scoreEmailCaptureConfidence(email, 'direct', []),
      mode,
      parseMethod: 'direct',
      tokenStream: [],
    };
  }

  const phoneticExpanded = expandPhoneticSpelling(trimmed);
  const hasPhonetic = /\bfor\b/i.test(trimmed) || /\b(alpha|bravo|charlie|boy|apple|sugar)\b/i.test(trimmed);

  const stream = parseEmailTokenStream(
    mode === 'spelling' || /\b(at the rate|at sign|at)\b/i.test(phoneticExpanded)
      ? phoneticExpanded
      : trimmed,
  );
  if (stream.email) {
    return {
      email: stream.email,
      confidence: scoreEmailCaptureConfidence(stream.email, 'token_stream', stream.tokens),
      mode,
      parseMethod: 'token_stream',
      tokenStream: stream.tokens,
    };
  }

  if (hasPhonetic || mode === 'spelling') {
    const normalized = normalizeSpokenEmail(phoneticExpanded);
    if (normalized.includes('@')) {
      return {
        email: normalized,
        confidence: scoreEmailCaptureConfidence(normalized, 'phonetic_spelling', stream.tokens),
        mode,
        parseMethod: 'phonetic_spelling',
        tokenStream: stream.tokens,
      };
    }
  }

  const spokenCue =
    /\b(at the rate|at sign|at|dot)\b/i.test(trimmed) || trimmed.includes('@');
  if (spokenCue) {
    const normalized = normalizeSpokenEmail(trimmed);
    if (normalized.includes('@')) {
      return {
        email: normalized,
        confidence: scoreEmailCaptureConfidence(normalized, 'spoken_normalize', []),
        mode,
        parseMethod: 'spoken_normalize',
        tokenStream: [],
      };
    }
  }

  const letterByLetter = parseLetterByLetterEmail(trimmed);
  if (letterByLetter) {
    return {
      email: letterByLetter,
      confidence: scoreEmailCaptureConfidence(letterByLetter, 'letter_by_letter', stream.tokens),
      mode,
      parseMethod: 'letter_by_letter',
      tokenStream: stream.tokens,
    };
  }

  return { email: null, confidence: 0, mode, parseMethod: 'none', tokenStream: stream.tokens };
}

export function extractEmailFromSpeech(text: string, options?: { mode?: EmailCaptureMode }): string | null {
  return captureEmailFromVoice(text, options).email;
}

export function isEmailCaptureConfidenceSufficient(confidence: number): boolean {
  return confidence >= EMAIL_CAPTURE_MIN_CONFIDENCE;
}

/** Negative phrases always override positive email-confirmation detection. */
export function isEmailConfirmationNegative(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const lower = t.toLowerCase();

  const negativePatterns: RegExp[] = [
    /\bno\b/i,
    /\bnope\b/i,
    /\bnah\b/i,
    /\bnot correct\b/i,
    /\bincorrect\b/i,
    /\bwrong\b/i,
    /\bthat'?s wrong\b/i,
    /\bnot my email\b/i,
    /\bnot right\b/i,
    /\bchange it\b/i,
    /\bchange that\b/i,
    /\brepeat it\b/i,
    /\blet me repeat\b/i,
    /\bspell it again\b/i,
    /\btry again\b/i,
    /\bretry\b/i,
    /\bthat is wrong\b/i,
    /\bthat'?s not\b/i,
    /\bit'?s not correct\b/i,
    /دوبارہ/,
    /غلط/,
    /نہیں/,
  ];

  if (negativePatterns.some((re) => re.test(lower) || re.test(t))) return true;

  if (/\bnot\b/i.test(lower) && /\b(correct|right|my email)\b/i.test(lower)) return true;

  return false;
}

export function isEmailConfirmationAffirmative(text: string): boolean {
  if (isEmailConfirmationNegative(text)) return false;

  const t = text.toLowerCase().trim();
  if (!t) return false;

  if (extractEmailFromSpeech(text)) return false;

  if (/\b(that'?s|yes).{0,24}my email\b/.test(t)) return true;

  const affirmativePatterns: RegExp[] = [
    /\b(yes|yeah|yep)\b/i,
    /\b(that'?s right|that is right)\b/i,
    /\b(this is correct|that'?s correct|that is correct)\b/i,
    /\b(exactly|absolutely|confirmed|confirm)\b/i,
    /^(ok|okay|si|sì|да|ок)\.?$/i,
  ];

  if (affirmativePatterns.some((re) => re.test(t))) return true;

  if (/^(correct|right)\.?$/i.test(t)) return true;

  return false;
}

export function containsInlineEmailConfirmation(text: string): boolean {
  if (isEmailConfirmationNegative(text)) return false;

  const email = extractEmailFromSpeech(text);
  if (!email) return false;

  const t = text.toLowerCase();
  const inlineAffirmativePatterns: RegExp[] = [
    /\bthis is correct\b/,
    /\bthat'?s correct\b/,
    /\bthat is correct\b/,
    /\bcorrect email\b/,
    /\byes that'?s my email\b/,
    /\bthat'?s my email\b/,
    /\bis correct\b/,
    /\bexactly\b/,
    /\byes[, ]+that'?s right\b/,
  ];

  return inlineAffirmativePatterns.some((re) => re.test(t));
}

export function formatEmailForVoiceConfirmation(email: string): string {
  const t = email.trim().toLowerCase();
  const at = t.indexOf('@');
  if (at < 1) return email.trim();
  const speakChar = (ch: string): string => {
    if (/\d/.test(ch)) return DIGIT_TO_WORD[ch] ?? ch;
    if (ch === '.') return 'dot';
    return ch;
  };
  const speakSegment = (segment: string): string =>
    [...segment].map(speakChar).join(' ');
  return `${speakSegment(t.slice(0, at))} at ${speakSegment(t.slice(at + 1))}`;
}

export function spellEmailForCaller(email: string): string {
  const spoken = formatEmailForVoiceConfirmation(email);
  return `Just to confirm, I captured your email as ${spoken}. Is that correct?`;
}

export function buildEmailRecollectionAfterRejectPrompt(): string {
  return 'No problem. Please spell it again, one character at a time.';
}

export function isCallerAskingEmailSpellback(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (!t) return false;
  return (
    /\brepeat\s+my\s+email\b/i.test(t) ||
    /\bwhat email did you (capture|get|hear|record)\b/i.test(t) ||
    /\bspell\s+it\s+back\b/i.test(t) ||
    /\btell\s+me\s+letter\s+by\s+letter\b/i.test(t) ||
    /\b(spell|repeat).{0,40}(email|captured|back)\b/i.test(t) ||
    (/\bletter by letter\b/i.test(t) && /\b(you|captured|have|repeat)\b/i.test(t))
  );
}
