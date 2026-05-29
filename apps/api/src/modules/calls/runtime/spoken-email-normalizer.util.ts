/**
 * Spoken email normalization — no imports from checkout/language modules (avoids circular deps).
 */

export const VOICE_EMAIL_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

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

function preprocessSpokenEmailInput(email: string): string {
  const trimmed = email.trim().toLowerCase();
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

export function parseLetterByLetterEmail(text: string): string | null {
  const trimmed = text.trim().toLowerCase();
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
  const local = parseDigitWords(parseDoubleTripleDigits(localRaw))
    .replace(/\s+/g, '');
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

export function extractEmailFromSpeech(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const direct = trimmed.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (direct) return direct[0];

  const spokenCue =
    /\b(at the rate|at sign|at|dot)\b/i.test(trimmed) || trimmed.includes('@');
  if (spokenCue) {
    const normalized = normalizeSpokenEmail(trimmed);
    if (normalized.includes('@')) return normalized;
  }

  const letterByLetter = parseLetterByLetterEmail(trimmed);
  if (letterByLetter) return letterByLetter;

  return null;
}

export function containsInlineEmailConfirmation(text: string): boolean {
  const email = extractEmailFromSpeech(text);
  if (!email) return false;
  const t = text.toLowerCase();
  return (
    /\b(this is correct|that's correct|that is correct|correct email|yes that'?s my email|that'?s my email|is correct|exactly)\b/.test(
      t,
    ) || /\b(correct|right)\b/.test(t)
  );
}

export function formatEmailForVoiceConfirmation(email: string): string {
  const t = email.trim().toLowerCase();
  const at = t.indexOf('@');
  if (at < 1) return email.trim();
  const speakSegment = (segment: string): string => {
    const parts: string[] = [];
    let letters = '';
    for (const ch of segment) {
      if (/\d/.test(ch)) {
        if (letters) {
          parts.push(letters);
          letters = '';
        }
        parts.push(DIGIT_TO_WORD[ch] ?? ch);
      } else if (ch === '.') {
        if (letters) {
          parts.push(letters);
          letters = '';
        }
        parts.push('dot');
      } else {
        letters += ch;
      }
    }
    if (letters) parts.push(letters);
    return parts.join(' ');
  };
  return `${speakSegment(t.slice(0, at))} at ${speakSegment(t.slice(at + 1))}`;
}

export function spellEmailForCaller(email: string): string {
  const t = email.trim().toLowerCase();
  const at = t.indexOf('@');
  const local = at < 1 ? t : t.slice(0, at);
  const domain = at < 1 ? '' : t.slice(at + 1);
  const spellChar = (ch: string): string => {
    if (/\d/.test(ch)) return DIGIT_TO_WORD[ch] ?? ch;
    if (ch === '.') return 'dot';
    return ch;
  };
  const spelledLocal = [...local].map(spellChar).join(' ');
  const spelledDomain = domain.replace(/\./g, ' dot ');
  return `I captured: ${spelledLocal} at ${spelledDomain}.`;
}

export function isCallerAskingEmailSpellback(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (!t) return false;
  return (
    /\b(spell|repeat).{0,40}(email|captured|back)\b/i.test(t) ||
    /\bwhat email did you (capture|get|hear)\b/i.test(t) ||
    (/\bletter by letter\b/i.test(t) && /\b(you|captured|have|repeat)\b/i.test(t))
  );
}
