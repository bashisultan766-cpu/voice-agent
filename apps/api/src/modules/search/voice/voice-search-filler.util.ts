import type { UserUtteranceIntent } from '../../calls/runtime/user-intent-classifier.util';

const SEARCH_FILLERS = [
  'One moment while I check that for you.',
  'Looking that up for you now.',
  'Checking similar titles in our catalog.',
  'Let me pull that up for you.',
  'Searching our shelves for that title.',
] as const;

const GENERIC_FILLERS = [
  'One moment please.',
  'Just a second.',
] as const;

function hashPick(seed: string, options: readonly string[]): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return options[Math.abs(h) % options.length]!;
}

/** Non-repetitive filler while async search / LLM runs (voice-first UX). */
export function pickVoiceSearchFillerPhrase(args: {
  callSessionId: string;
  intent: UserUtteranceIntent;
  queryPreview?: string;
}): string {
  const seed = `${args.callSessionId}:${args.queryPreview ?? ''}:${args.intent}`;
  if (args.intent === 'product_search' || args.intent === 'product_question') {
    return hashPick(seed, SEARCH_FILLERS);
  }
  return hashPick(seed, GENERIC_FILLERS);
}

export const DEFERRED_INSTANT_ACK_PHRASE = 'One moment while I check that for you.';
