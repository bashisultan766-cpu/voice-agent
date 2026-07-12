/**
 * STT noise gate — drops meaningless Twilio background-noise transcripts
 * before they enter the orchestrator or event stream.
 */

/** Common phone-STT hallucinations and fillers (with optional trailing punctuation). */
const EXACT_FILLERS = new Set([
  "um",
  "uh",
  "uhh",
  "umm",
  "hmm",
  "hm",
  "ah",
  "eh",
  "er",
  "okay",
  "ok",
  "yeah",
  "yea",
  "huh",
  "mm",
  "mmm",
]);

const FILLER_PATTERNS = [
  /^um+\.?$/i,
  /^uh+\.?$/i,
  /^okay\.?$/i,
  /^ok\.?$/i,
  /^hmm+\.?$/i,
  /^ah+\.?$/i,
  /^oh+\.?$/i,
];

const UNINTELLIGIBLE_PATTERNS = [
  /^\[?(inaudible|unintelligible|cough|laughter|noise|blank)\]?\.?$/i,
  /^\.+$/,
  /^\*+$/,
  /^cough\.?$/i,
  /^ahem\.?$/i,
];

/** Normalize transcript for length / filler checks. */
export function cleanTranscriptForNoiseGate(text: string): string {
  return (text ?? "").trim().replace(/\s+/g, " ");
}

function normalizedFillerToken(text: string): string {
  return text.toLowerCase().replace(/[.!?,…]+$/g, "").trim();
}

/**
 * Short yes/no confirmations must reach email / checkout flows even though
 * they are ≤3 characters (the generic noise length gate would drop them).
 */
export function isShortConfirmationTranscript(text: string): boolean {
  const cleaned = cleanTranscriptForNoiseGate(text);
  if (!cleaned) return false;
  return /^(yes|no|yeah|yep|yup|nope|nah|correct|right)[.!?]?$/i.test(cleaned);
}

/** Cough / inaudible / empty-ish STT that must not hit the LLM. */
export function isUnintelligibleTranscript(text: string): boolean {
  const cleaned = cleanTranscriptForNoiseGate(text);
  if (!cleaned) return true;
  for (const pattern of UNINTELLIGIBLE_PATTERNS) {
    if (pattern.test(cleaned)) return true;
  }
  return false;
}

/**
 * True when STT output is background noise, not caller speech.
 * DTMF numeric input is preserved when `allowShortNumeric` is set.
 */
export function isNoiseTranscript(
  text: string,
  options: { allowShortNumeric?: boolean } = {},
): boolean {
  const cleaned = cleanTranscriptForNoiseGate(text);
  if (!cleaned) return true;

  if (options.allowShortNumeric && /^\d+$/.test(cleaned)) {
    return false;
  }

  if (isUnintelligibleTranscript(cleaned)) return true;

  if (cleaned.length <= 3) return true;

  const token = normalizedFillerToken(cleaned);
  if (EXACT_FILLERS.has(token)) return true;

  for (const pattern of FILLER_PATTERNS) {
    if (pattern.test(cleaned) || pattern.test(token)) return true;
  }

  return false;
}

/**
 * ConversationRelay gate: empty / cough / filler → lightweight prompt.
 * Short yes/no confirmations are allowed through.
 */
export function shouldPromptAreYouStillThere(text: string): boolean {
  const cleaned = cleanTranscriptForNoiseGate(text);
  if (!cleaned) return true;
  if (isShortConfirmationTranscript(cleaned)) return false;
  if (isUnintelligibleTranscript(cleaned)) return true;
  return isNoiseTranscript(cleaned);
}
