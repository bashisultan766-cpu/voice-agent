/**
 * Turn-end / Wait-for-Clause heuristics — Concierge Brain pacing.
 * Incomplete mid-thought transcripts must stay in LISTENING_WAIT (no agent reply).
 */
export type TurnEndDecision =
  | { action: "respond"; reason: string }
  | { action: "listening_wait"; reason: string };

const TRAILING_INCOMPLETE =
  /\b(a|an|the|to|for|of|and|or|but|with|from|my|your|our|their|some|any|about|like|into|wanna|gonna|want\s+to|need\s+to|looking\s+for|buy|get|order|add|find)\s*\.?$/i;

const ELLIPSIS_OR_TRAIL = /(\.\.\.|…|--|—)\s*$/;

/** Short complete replies that should never wait. */
const COMPLETE_MICRO =
  /^(yes|yeah|yep|yup|no|nope|ok|okay|sure|thanks|thank you|bye|goodbye|hello|hi|hey|done|stop|finished|that's all|thats all)[\s.!?]*$/i;

/**
 * True when the transcript looks like an unfinished clause (thinking mid-sentence).
 */
export function isIncompleteUtterance(text: string): boolean {
  const raw = (text ?? "").trim();
  if (!raw) return false;
  if (COMPLETE_MICRO.test(raw)) return false;

  if (ELLIPSIS_OR_TRAIL.test(raw)) return true;

  // Explicit terminal punctuation → complete.
  if (/[.?!]"?\s*$/.test(raw) && !ELLIPSIS_OR_TRAIL.test(raw)) {
    // "I want to buy a." alone is still incomplete after a bare article.
    if (TRAILING_INCOMPLETE.test(raw.replace(/[.?!]"?\s*$/, "").trim())) {
      return true;
    }
    return false;
  }

  if (TRAILING_INCOMPLETE.test(raw)) return true;

  // Classic truncated openers without a noun phrase after.
  if (
    /\b(i want to|i'd like to|i need to|i'm looking for|can you|could you|please)\s*$/i.test(
      raw,
    )
  ) {
    return true;
  }

  // Ends with dangling "a/an/the" + optional filler (e.g. "I want to buy a")
  if (/\b(a|an|the)\s*$/i.test(raw)) return true;

  return false;
}

/**
 * Wait-for-Clause gate: hold in LISTENING_WAIT when the clause is incomplete.
 */
export function decideTurnEnd(text: string): TurnEndDecision {
  if (isIncompleteUtterance(text)) {
    return { action: "listening_wait", reason: "incomplete_clause" };
  }
  return { action: "respond", reason: "terminal_or_complete" };
}

/** Merge buffered wait text with a new STT fragment. */
export function mergeListeningWaitBuffer(
  prior: string | undefined,
  next: string,
): string {
  const a = (prior ?? "").trim();
  const b = (next ?? "").trim();
  if (!a) return b;
  if (!b) return a;
  if (b.toLowerCase().startsWith(a.toLowerCase())) return b;
  return `${a} ${b}`.replace(/\s+/g, " ").trim();
}

export const TurnEndHeuristics = {
  isIncompleteUtterance,
  decideTurnEnd,
  mergeListeningWaitBuffer,
} as const;
