/**
 * Enterprise telephony spelling capture — resists Twilio STT merging spelled letters into words.
 * No Nest imports (safe for unit tests).
 */
import {
  captureEmailFromVoice,
  expandPhoneticSpelling,
  parseDigitWords,
  parseDoubleTripleDigits,
  parseEmailTokenStream,
  VOICE_EMAIL_REGEX,
  type EmailCaptureMode,
  type EmailCaptureResult,
} from './spoken-email-normalizer.util';

export const EMAIL_CAPTURE_MIN_CONFIDENCE = 0.92;

export const VOICE_MODE_KEY = 'voiceMode';
export const VOICE_MODE_SPELLING_CAPTURE = 'SPELLING_CAPTURE';

const DOMAIN_WORDS = new Set([
  'gmail',
  'yahoo',
  'hotmail',
  'outlook',
  'icloud',
  'proton',
  'live',
  'msn',
  'aol',
  'com',
  'org',
  'net',
  'edu',
  'co',
  'uk',
  'pk',
  'io',
  'dot',
  'at',
]);

const COMMON_SPOKEN_EMAIL_WORDS = new Set([
  'at',
  'dot',
  'the',
  'rate',
  'sign',
  'email',
  'my',
  'is',
  ...DOMAIN_WORDS,
]);

export type SpellingPatternKind =
  | 'isolated_letters'
  | 'phonetic_for'
  | 'nato_phonetic'
  | 'digit_groups'
  | 'email_cue'
  | 'none';

export type TelephonySpellingPipelineResult = {
  rawSpeechTranscript: string;
  normalizedConversationTranscript: string;
  normalizedSpellingTranscript: string;
  orchestratorText: string;
  email: string | null;
  spellingConfidence: number;
  emailCaptureConfidence: number;
  spellingModeActive: boolean;
  spellingCadenceDetected: boolean;
  twilioTranscriptCorruptionDetected: boolean;
  spellingParserUsed: boolean;
  spellingRecoveryTriggered: boolean;
  spellingPattern: SpellingPatternKind;
  parseMethod: string;
  tokenStream: string[];
  logFields: Record<string, unknown>;
};

/** Session is in telephony spelling capture (email collection). */
export function isSpellingCaptureActive(sessionMeta: Record<string, unknown>): boolean {
  if (sessionMeta[VOICE_MODE_KEY] === VOICE_MODE_SPELLING_CAPTURE) return true;
  if (sessionMeta.emailCaptureMode === 'spelling') return true;
  const orderState = sessionMeta.orderState;
  return orderState === 'EMAIL_COLLECTING' || orderState === 'EMAIL_CONFIRMING';
}

export function activateSpellingCaptureModePatch(): Record<string, string> {
  return {
    [VOICE_MODE_KEY]: VOICE_MODE_SPELLING_CAPTURE,
    emailCaptureMode: 'spelling',
  };
}

/** Detect spelled-letter / phonetic patterns in transcript text. */
export function detectSpellingPattern(text: string): {
  detected: boolean;
  kind: SpellingPatternKind;
  isolatedLetterCount: number;
} {
  const t = text.trim();
  if (!t) return { detected: false, kind: 'none', isolatedLetterCount: 0 };

  const isolatedLetters = t.match(/\b[a-zA-Z]\b/g) ?? [];
  const isolatedCount = isolatedLetters.length;

  if (isolatedCount >= 3) {
    return { detected: true, kind: 'isolated_letters', isolatedLetterCount: isolatedCount };
  }
  if (/\b[a-z]\s+for\s+[a-z]+\b/i.test(t)) {
    return { detected: true, kind: 'phonetic_for', isolatedLetterCount: isolatedCount };
  }
  if (/\b(alpha|bravo|charlie|delta|echo|foxtrot|golf|hotel|india|juliet|kilo|lima|mike|november|oscar|papa|quebec|romeo|sierra|tango|uniform|victor|whiskey|xray|yankee|zulu)\b/i.test(t)) {
    return { detected: true, kind: 'nato_phonetic', isolatedLetterCount: isolatedCount };
  }
  if (/\b(double|triple)\s+(one|two|three|four|five|six|seven|eight|nine|\d)\b/i.test(t)) {
    return { detected: true, kind: 'digit_groups', isolatedLetterCount: isolatedCount };
  }
  if (/\b(at the rate|at sign|at gmail|@\s*gmail|dot com)\b/i.test(t) || t.includes('@')) {
    return { detected: true, kind: 'email_cue', isolatedLetterCount: isolatedCount };
  }

  return { detected: false, kind: 'none', isolatedLetterCount: isolatedCount };
}

/** Letter-by-letter cadence: many short tokens, caps alternation, explicit pauses in text. */
export function detectSpellingCadence(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const tokens = t.split(/\s+/).filter(Boolean);
  if (tokens.length < 4) return false;

  const singleCharTokens = tokens.filter((tok) => /^[a-zA-Z]$/.test(tok)).length;
  if (singleCharTokens >= 3) return true;

  const capsWords = tokens.filter((tok) => /^[A-Z][a-z]{1,8}$/.test(tok)).length;
  const digitTokens = tokens.filter((tok) => /^\d+$/.test(tok)).length;
  if (capsWords >= 2 && tokens.length >= 3) return true;
  if (digitTokens >= 1 && singleCharTokens >= 2) return true;

  return /\b(\.{2,3}|…|-)\b/.test(t);
}

/**
 * Preserve isolated characters; never collapse "D A S H I" into a word.
 * Does NOT run conversational cleanup.
 */
export function normalizeSpellingTranscript(raw: string): string {
  let t = raw.trim();
  if (!t) return t;

  t = t.replace(/[,;]/g, ' ');
  t = expandPhoneticSpelling(t);

  const tokens = t.split(/\s+/).filter(Boolean);
  const out: string[] = [];

  for (const tok of tokens) {
    if (/^[a-zA-Z]$/.test(tok)) {
      out.push(tok.toLowerCase());
      continue;
    }
    if (/^[A-Z]$/.test(tok)) {
      out.push(tok.toLowerCase());
      continue;
    }
    if (/^\d+$/.test(tok)) {
      out.push(tok);
      continue;
    }
    const lower = tok.toLowerCase();
    if (DOMAIN_WORDS.has(lower) || COMMON_SPOKEN_EMAIL_WORDS.has(lower)) {
      out.push(lower);
      continue;
    }
    if (/^[a-z0-9][a-z0-9._-]*$/i.test(tok)) {
      out.push(lower);
    }
  }

  let joined = out.length > 0 ? out.join(' ') : t.toLowerCase();
  joined = parseDigitWords(parseDoubleTripleDigits(joined));
  return joined.replace(/\s{2,}/g, ' ').trim();
}

function isLikelyMergedSpellingToken(token: string): boolean {
  const w = token.toLowerCase();
  if (DOMAIN_WORDS.has(w) || COMMON_SPOKEN_EMAIL_WORDS.has(w)) return false;
  if (/^\d+$/.test(w)) return false;
  if (w.length < 2 || w.length > 14) return false;
  return /^[A-Za-z]+$/.test(token);
}

/**
 * Recover letters when Twilio merged "D A S H I" → "Dashi", "S A A B" → "Saab".
 */
export function expandMergedSpellingLocalPart(localPart: string): {
  expanded: string;
  recoveryTriggered: boolean;
} {
  const trimmed = localPart.trim();
  if (!trimmed) return { expanded: '', recoveryTriggered: false };

  const singleLetters = trimmed.match(/\b[a-zA-Z]\b/g);
  if (singleLetters && singleLetters.length >= 4) {
    return {
      expanded: trimmed.replace(/\s+/g, '').replace(/[^a-z0-9.]/gi, ''),
      recoveryTriggered: false,
    };
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length <= 1 && !trimmed.includes(' ')) {
    if (isLikelyMergedSpellingToken(trimmed) && trimmed.length >= 3) {
      return { expanded: trimmed.toLowerCase(), recoveryTriggered: true };
    }
    return { expanded: trimmed.toLowerCase(), recoveryTriggered: false };
  }

  const chars: string[] = [];
  let recoveryTriggered = false;
  for (const part of tokens) {
    if (/^\d+$/.test(part)) {
      chars.push(part);
      continue;
    }
    if (part.length === 1) {
      chars.push(part.toLowerCase());
      continue;
    }
    if (isLikelyMergedSpellingToken(part)) {
      chars.push(...part.toLowerCase().split(''));
      recoveryTriggered = true;
    } else {
      chars.push(part.toLowerCase());
    }
  }

  return { expanded: chars.join(''), recoveryTriggered };
}

function extractEmailPartsFromTranscript(raw: string): {
  localPart: string;
  domainPart: string;
  compactEmail: string | null;
} {
  const atSplit = raw.match(/^(.+?)\s*@\s*(.+)$/i);
  if (atSplit) {
    const localPart = atSplit[1]!.trim();
    const domainPart = atSplit[2]!.trim();
    const compactEmail = `${localPart.replace(/\s+/g, '')}@${domainPart.replace(/\s+/g, '').replace(/\bdot\b/gi, '.')}`.toLowerCase();
    return { localPart, domainPart, compactEmail };
  }

  const compact = raw.replace(/\s+/g, '');
  const compactMatch = compact.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (compactMatch) {
    const [localPart, domainPart] = compactMatch[0].split('@');
    return {
      localPart: localPart ?? '',
      domainPart: domainPart ?? '',
      compactEmail: compactMatch[0].toLowerCase(),
    };
  }

  const atIdx = raw.search(/\s@\s|@/);
  if (atIdx > 0) {
    return {
      localPart: raw.slice(0, atIdx).trim(),
      domainPart: raw.slice(atIdx + 1).trim(),
      compactEmail: null,
    };
  }

  const spokenAt = raw.split(/\b(at the rate|at sign|at)\b/i);
  if (spokenAt.length > 1) {
    return {
      localPart: spokenAt[0]!.trim(),
      domainPart: spokenAt.slice(1).join(' ').trim(),
      compactEmail: null,
    };
  }

  return { localPart: raw.trim(), domainPart: '', compactEmail: null };
}

/** Twilio merged spaced spelling into pronounceable tokens before @. */
export function detectTwilioTranscriptCorruption(
  raw: string,
  normalizedSpelling: string,
): boolean {
  const rawPattern = detectSpellingPattern(raw);
  if (rawPattern.isolatedLetterCount >= 3) return false;

  const { localPart, compactEmail } = extractEmailPartsFromTranscript(raw);
  if (!compactEmail && !/\b(at|@)\s*(gmail|yahoo|hotmail)/i.test(raw) && !raw.includes('@')) {
    return false;
  }

  if (compactEmail && /\s/.test(localPart)) {
    return true;
  }

  const mergedWords = localPart
    .trim()
    .split(/\s+/)
    .filter((w) => isLikelyMergedSpellingToken(w));

  if (mergedWords.length >= 2) return true;
  if (mergedWords.length === 1 && mergedWords[0]!.length >= 4) return true;

  const normLetters = normalizedSpelling.match(/\b[a-z]\b/g)?.length ?? 0;
  const rawLetters = raw.match(/\b[a-zA-Z]\b/g)?.length ?? 0;
  if (normLetters >= 3 && rawLetters < 2) return true;

  return false;
}

export function recoverEmailFromCorruptedSpellingTranscript(raw: string): {
  email: string | null;
  recoveryTriggered: boolean;
  localExpanded: string;
} {
  const parts = extractEmailPartsFromTranscript(raw);
  if (!parts.localPart) {
    return { email: null, recoveryTriggered: false, localExpanded: '' };
  }

  const { expanded: localExpanded, recoveryTriggered } = expandMergedSpellingLocalPart(
    parts.localPart.replace(/[._-]/g, ' '),
  );
  let domain = (parts.domainPart || '')
    .toLowerCase()
    .replace(/\bdot\b/g, '.')
    .replace(/\bat\b/g, '')
    .replace(/\s+/g, '');
  if (!domain.includes('.') && domain.includes('gmail')) {
    domain = 'gmail.com';
  }
  domain = domain.replace(/^\.+/, '');
  const email = `${localExpanded}@${domain}`;
  if (!VOICE_EMAIL_REGEX.test(email)) {
    return { email: null, recoveryTriggered, localExpanded };
  }
  return { email, recoveryTriggered, localExpanded };
}

export type SpellingConfidenceInput = {
  raw: string;
  normalizedSpelling: string;
  email: string | null;
  parseMethod: string;
  tokenStream: string[];
  spellingPattern: ReturnType<typeof detectSpellingPattern>;
  spellingCadenceDetected: boolean;
  twilioTranscriptCorruptionDetected: boolean;
  spellingRecoveryTriggered: boolean;
  baseCaptureConfidence: number;
  retryCount?: number;
};

/** Enterprise spelling confidence — blocks checkout below EMAIL_CAPTURE_MIN_CONFIDENCE. */
export function calculateSpellingConfidence(input: SpellingConfidenceInput): number {
  if (!input.email || !VOICE_EMAIL_REGEX.test(input.email)) return 0;

  let score = input.baseCaptureConfidence;

  if (input.spellingPattern.detected) score += 0.04;
  if (input.spellingPattern.isolatedLetterCount >= 5) score += 0.06;
  if (input.spellingCadenceDetected) score += 0.05;
  if (input.parseMethod === 'token_stream') score += 0.04;
  if (input.parseMethod === 'telephony_recovery') score += 0.02;
  if (input.parseMethod === 'direct' && !input.twilioTranscriptCorruptionDetected) score += 0.08;

  if (input.twilioTranscriptCorruptionDetected && !input.spellingRecoveryTriggered) {
    score -= 0.25;
  }
  if (input.twilioTranscriptCorruptionDetected && input.spellingRecoveryTriggered) {
    score -= 0.08;
  }

  const unknownRatio =
    input.tokenStream.length > 0
      ? input.tokenStream.filter((t) => t.length > 1 && !DOMAIN_WORDS.has(t.toLowerCase())).length /
        input.tokenStream.length
      : 0;
  score -= unknownRatio * 0.12;

  const retries = input.retryCount ?? 0;
  if (retries >= 2) score -= 0.06;
  if (retries >= 3) score -= 0.1;

  const [local] = input.email.split('@');
  if (local && local.length >= 5 && local.length <= 64) score += 0.03;

  return Math.min(1, Math.max(0, score));
}

export function isEmailCaptureConfidenceSufficient(confidence: number): boolean {
  return confidence >= EMAIL_CAPTURE_MIN_CONFIDENCE;
}

/**
 * Spelling-first pipeline: bypass conversational normalization; recover Twilio corruption.
 */
export function processTelephonySpellingPipeline(
  rawSpeech: string,
  options?: { retryCount?: number; forceSpellingMode?: boolean },
): TelephonySpellingPipelineResult {
  const rawSpeechTranscript = rawSpeech.trim();
  const spellingModeActive = options?.forceSpellingMode !== false;
  const normalizedSpellingTranscript = normalizeSpellingTranscript(rawSpeechTranscript);
  const normalizedConversationTranscript = rawSpeechTranscript;

  const spellingPattern = detectSpellingPattern(rawSpeechTranscript);
  const spellingCadenceDetected =
    detectSpellingCadence(rawSpeechTranscript) || spellingPattern.detected;
  const twilioTranscriptCorruptionDetected = detectTwilioTranscriptCorruption(
    rawSpeechTranscript,
    normalizedSpellingTranscript,
  );

  let spellingRecoveryTriggered = false;
  let email: string | null = null;
  let parseMethod = 'none';
  let tokenStream: string[] = [];
  let baseConfidence = 0;

  const stream = parseEmailTokenStream(normalizedSpellingTranscript);
  if (stream.email) {
    email = stream.email;
    parseMethod = 'token_stream';
    tokenStream = stream.tokens;
    baseConfidence = 0.9;
  }

  if (!email) {
    const baseCapture = captureEmailFromVoice(normalizedSpellingTranscript, { mode: 'spelling' });
    if (baseCapture.email) {
      email = baseCapture.email;
      parseMethod = baseCapture.parseMethod;
      tokenStream = baseCapture.tokenStream;
      baseConfidence = baseCapture.confidence;
    }
  }

  if (!email && twilioTranscriptCorruptionDetected) {
    const recovered = recoverEmailFromCorruptedSpellingTranscript(rawSpeechTranscript);
    if (recovered.email) {
      email = recovered.email;
      parseMethod = 'telephony_recovery';
      spellingRecoveryTriggered = recovered.recoveryTriggered;
      baseConfidence = 0.86;
    }
  }

  if (!email && spellingCadenceDetected) {
    const spokenNorm = captureEmailFromVoice(
      normalizedSpellingTranscript.replace(/\s+at\s+/gi, ' at '),
      { mode: 'spelling' },
    );
    if (spokenNorm.email) {
      email = spokenNorm.email;
      parseMethod = spokenNorm.parseMethod;
      tokenStream = spokenNorm.tokenStream;
      baseConfidence = spokenNorm.confidence;
    }
  }

  const spellingParserUsed = email != null;
  const spellingConfidence = calculateSpellingConfidence({
    raw: rawSpeechTranscript,
    normalizedSpelling: normalizedSpellingTranscript,
    email,
    parseMethod,
    tokenStream,
    spellingPattern,
    spellingCadenceDetected,
    twilioTranscriptCorruptionDetected,
    spellingRecoveryTriggered,
    baseCaptureConfidence: baseConfidence,
    retryCount: options?.retryCount,
  });

  const orchestratorText = email ?? normalizedSpellingTranscript;

  const logFields: Record<string, unknown> = {
    spellingModeActive,
    rawSpellingTranscript: rawSpeechTranscript.slice(0, 500),
    spellingCadenceDetected,
    spellingConfidence,
    twilioTranscriptCorruptionDetected,
    spellingParserUsed,
    spellingRecoveryTriggered,
    spellingPattern: spellingPattern.kind,
    emailCaptureConfidence: spellingConfidence,
    parseMethod,
  };

  return {
    rawSpeechTranscript,
    normalizedConversationTranscript,
    normalizedSpellingTranscript,
    orchestratorText,
    email,
    spellingConfidence,
    emailCaptureConfidence: spellingConfidence,
    spellingModeActive,
    spellingCadenceDetected,
    twilioTranscriptCorruptionDetected,
    spellingParserUsed,
    spellingRecoveryTriggered,
    spellingPattern: spellingPattern.kind,
    parseMethod,
    tokenStream,
    logFields,
  };
}

/** Capture email using telephony spelling pipeline (orchestrator + voice runtime). */
export function captureEmailWithTelephonySpelling(
  rawSpeech: string,
  options?: { mode?: EmailCaptureMode; retryCount?: number },
): EmailCaptureResult & {
  spellingConfidence: number;
  telephony: TelephonySpellingPipelineResult;
} {
  const telephony = processTelephonySpellingPipeline(rawSpeech, {
    retryCount: options?.retryCount,
    forceSpellingMode: options?.mode === 'spelling' || options?.mode == null,
  });

  if (options?.mode !== 'spelling') {
    const basic = captureEmailFromVoice(rawSpeech, options);
    return {
      ...basic,
      spellingConfidence: basic.confidence,
      telephony,
    };
  }

  return {
    email: telephony.email,
    confidence: telephony.emailCaptureConfidence,
    mode: 'spelling',
    parseMethod: telephony.parseMethod,
    tokenStream: telephony.tokenStream,
    spellingConfidence: telephony.spellingConfidence,
    telephony,
  };
}

/** Plain + SSML spellback for confirmation (crystal-clear pacing). */
export function formatEmailForTelephonySpellback(email: string): {
  plain: string;
  ssml: string;
  spoken: string;
} {
  const t = email.trim().toLowerCase();
  const at = t.indexOf('@');
  if (at < 1) {
    return { plain: email, ssml: `<speak>${email}</speak>`, spoken: email };
  }

  const spellSegment = (segment: string): string[] => {
    const parts: string[] = [];
    for (const ch of segment) {
      if (/\d/.test(ch)) parts.push(ch);
      else if (ch === '.') parts.push('dot');
      else parts.push(ch);
    }
    return parts;
  };

  const localParts = spellSegment(t.slice(0, at));
  const domainParts = spellSegment(t.slice(at + 1));
  const plainLocal = localParts.join(' ');
  const plainDomain = domainParts.join(' ');
  const plain = `${plainLocal} at ${plainDomain}`;

  const ssmlParts = [...localParts, 'at', ...domainParts];
  const ssmlBody = ssmlParts
    .map((p) => `<break time="220ms"/>${escapeXmlSsml(p)}`)
    .join('');
  const ssml = `<speak><prosody rate="85%">${ssmlBody}</prosody></speak>`;

  return { plain, ssml, spoken: plain };
}

function escapeXmlSsml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildTelephonyEmailConfirmationPrompt(email: string): string {
  const { spoken } = formatEmailForTelephonySpellback(email);
  return `Just to confirm, I captured your email as ${spoken}. Is that correct?`;
}

export const TELEPHONY_SPELLING_LOW_CONFIDENCE_PROMPT =
  'I may not have captured your email correctly. Please spell it again slowly, one character at a time.';

export type GatherTwiMLTiming = {
  speechTimeout: string;
  timeoutSeconds: number;
  pauseBeforeListenSeconds: number;
};

const DEFAULT_GATHER_TIMING: GatherTwiMLTiming = {
  speechTimeout: 'auto',
  timeoutSeconds: 5,
  pauseBeforeListenSeconds: 0,
};

/** Twilio Gather tuning for letter-by-letter capture (longer pauses, less interruption). */
export function resolveGatherTwiMLOptions(
  sessionMeta: Record<string, unknown>,
  base: GatherTwiMLTiming = DEFAULT_GATHER_TIMING,
): GatherTwiMLTiming {
  if (isSpellingCaptureActive(sessionMeta)) {
    return {
      speechTimeout: '4',
      timeoutSeconds: 14,
      pauseBeforeListenSeconds: 2,
    };
  }
  return base;
}
