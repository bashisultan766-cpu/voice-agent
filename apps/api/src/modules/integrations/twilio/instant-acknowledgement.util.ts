import type { UserUtteranceIntent } from '../../calls/runtime/user-intent-classifier.util';
import { isVoiceCommerceFastMode } from '../../calls/runtime/voice-commerce-fast-mode.util';
import { DEFERRED_INSTANT_ACK_PHRASE } from '../../search/voice/voice-search-filler.util';

export type InstantAckSelection =
  | {
      mode: 'sync_full_reply';
      ackReason: string;
    }
  | {
      mode: 'deferred_kickoff';
      /** Played before deferred poll; null = silent redirect (no Say). */
      instantPhrase: string | null;
      ackReason: string;
      markSessionLetMeCheck: boolean;
      nextLastProductQuery?: string | null;
    };

/** Simplified flow: only email-collection counts as “detail” phase for short acks. */
const ORDER_DETAIL_STATES = new Set(['EMAIL_COLLECTION']);

function normalizeQuery(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
}

function extractEmail(text: string): string | null {
  const m = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0] : null;
}

export function isYesNoOnlyUtterance(text: string): boolean {
  return /^(yes|yeah|yep|yup|no|nope|nah|naw)\.?$/i.test(text.trim());
}

/** Correction / clarification toward a different title. */
export function isLikelyProductCorrection(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\b(no|nope|not)\b.*\b(mean|meant|actually)\b|\bi mean\b|\b(instead|rather)\b|\bwrong (book|one|title|item)\b|\bnot that\b|\bdifferent (book|one|title)\b/i.test(
      t,
    ) || /^no,?\s+i\s+mean\b/i.test(t)
  );
}

export type SelectInstantAcknowledgementInput = {
  intent: UserUtteranceIntent;
  speechText: string;
  callState: string;
  metadata: Record<string, unknown>;
};

/**
 * Choose Twilio gather acknowledgement strategy.
 * Voice consistency rule: prefer deferred kickoff so final speech is rendered via ElevenLabs.
 */
export function selectInstantAcknowledgement(input: SelectInstantAcknowledgementInput): InstantAckSelection {
  const { intent, speechText, callState, metadata } = input;
  const trimmed = speechText.trim();
  const normQ = normalizeQuery(trimmed);
  const prevProduct = typeof metadata.lastProductQuery === 'string' ? metadata.lastProductQuery : null;

  if (intent === 'greeting' || intent === 'small_talk') {
    return {
      mode: 'deferred_kickoff',
      instantPhrase: null,
      ackReason: 'idle_greeting_or_small_talk_deferred',
      markSessionLetMeCheck: false,
    };
  }

  if (intent === 'store_identity_question' || intent === 'capability_question') {
    return {
      mode: 'deferred_kickoff',
      instantPhrase: null,
      ackReason: 'identity_or_capability_question_deferred',
      markSessionLetMeCheck: false,
    };
  }

  if (isYesNoOnlyUtterance(trimmed) && callState !== 'IDLE') {
    return {
      mode: 'deferred_kickoff',
      instantPhrase: null,
      ackReason: 'yes_no_in_flow',
      markSessionLetMeCheck: false,
    };
  }

  const hasEmail = Boolean(extractEmail(trimmed));
  const emailProvisionCue =
    /\b(my email|email is|e-?mail is|it'?s |the email is|spell(?:ing)? (?:my )?email)\b/i.test(trimmed);
  if (hasEmail && (callState === 'EMAIL_COLLECTION' || emailProvisionCue)) {
    return {
      mode: 'deferred_kickoff',
      instantPhrase: null,
      ackReason: 'email_provided',
      markSessionLetMeCheck: false,
    };
  }

  if (ORDER_DETAIL_STATES.has(callState)) {
    if (!isYesNoOnlyUtterance(trimmed) && intent !== 'product_search' && !hasEmail) {
      return {
        mode: 'deferred_kickoff',
        instantPhrase: null,
        ackReason: 'email_phase_listen',
        markSessionLetMeCheck: false,
      };
    }
  }

  const fastInstant = isVoiceCommerceFastMode() ? DEFERRED_INSTANT_ACK_PHRASE : null;

  if (intent === 'product_search') {
    if (isLikelyProductCorrection(trimmed)) {
      return {
        mode: 'deferred_kickoff',
        instantPhrase: fastInstant ?? 'Got it — checking that title instead.',
        ackReason: 'product_correction',
        markSessionLetMeCheck: true,
        nextLastProductQuery: normQ || null,
      };
    }
    if (prevProduct && normQ === prevProduct) {
      return {
        mode: 'deferred_kickoff',
        instantPhrase: fastInstant,
        ackReason: 'product_search_repeat_same_query',
        markSessionLetMeCheck: false,
        nextLastProductQuery: normQ || null,
      };
    }
    return {
      mode: 'deferred_kickoff',
      instantPhrase: fastInstant,
      ackReason: fastInstant ? 'product_search_instant_ack' : 'product_search_silent_kickoff',
      markSessionLetMeCheck: Boolean(fastInstant),
      nextLastProductQuery: normQ || null,
    };
  }

  if (intent === 'payment_question' || intent === 'product_question') {
    return {
      mode: 'deferred_kickoff',
      instantPhrase: fastInstant ?? 'One moment while I look that up.',
      ackReason: 'question_requires_direct_answer_deferred',
      markSessionLetMeCheck: Boolean(fastInstant),
    };
  }

  if (intent === 'purchase_confirmation') {
    return {
      mode: 'deferred_kickoff',
      instantPhrase: null,
      ackReason: 'purchase_confirmation_silent',
      markSessionLetMeCheck: false,
    };
  }

  if (isYesNoOnlyUtterance(trimmed)) {
    return {
      mode: 'deferred_kickoff',
      instantPhrase: null,
      ackReason: 'yes_no_idle',
      markSessionLetMeCheck: false,
    };
  }

  return {
    mode: 'deferred_kickoff',
    instantPhrase: null,
    ackReason: 'silent_default',
    markSessionLetMeCheck: false,
  };
}

export function buildInstantAckMetadataPatch(args: {
  selection: InstantAckSelection;
  intent: UserUtteranceIntent;
  letMeCheckUsedBefore: boolean;
  instantPhraseForLog: string | null;
  syncReplyText?: string;
}): {
  lastInstantAck: string;
  lastIntentDetected: UserUtteranceIntent;
  letMeCheckUsed: boolean;
  lastProductQuery?: string | null;
} {
  const { selection, intent, letMeCheckUsedBefore, instantPhraseForLog, syncReplyText } = args;
  let letMeCheckUsedAfter = letMeCheckUsedBefore;
  if (selection.mode === 'deferred_kickoff' && selection.markSessionLetMeCheck) {
    letMeCheckUsedAfter = true;
  }

  const lastInstantAck =
    selection.mode === 'sync_full_reply'
      ? (syncReplyText ?? '').trim() || '(sync_reply)'
      : instantPhraseForLog === null
        ? '(silent)'
        : instantPhraseForLog;

  let lastProductQuery: string | null | undefined;
  if (selection.mode === 'deferred_kickoff' && selection.nextLastProductQuery !== undefined) {
    lastProductQuery = selection.nextLastProductQuery;
  }

  return {
    lastInstantAck: lastInstantAck.slice(0, 500),
    lastIntentDetected: intent,
    letMeCheckUsed: letMeCheckUsedAfter,
    ...(lastProductQuery !== undefined ? { lastProductQuery } : {}),
  };
}
