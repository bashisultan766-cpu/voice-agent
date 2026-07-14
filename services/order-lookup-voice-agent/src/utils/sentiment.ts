/**
 * SentimentAnalyzer — frustration keyword shield for voice sessions.
 * Tracks cumulative frustration and arms Support-Mode escalation (Sentiment Shield).
 */
import type { CallSession } from "../types/order.js";
import { ensureSessionMemory } from "../agents/sessionMemory.js";
import { isEmailConfirmationActive } from "../agents/emailConfirmationManager.js";
import { logger } from "./logger.js";

const FRUSTRATION_KEYWORDS =
  /\b(?:stuck|again|what\s+is\s+this|useless|ridiculous|terrible|frustrated|frustrating|angry|annoyed|waste\s+of\s+time|not\s+working|broken|stupid|horrible|this\s+is\s+dumb|keep\s+(?:asking|repeating)|why\s+(?:won'?t|can'?t)|enough\s+already)\b/i;

export const SENTIMENT_SHIELD_THRESHOLD = 2;
/** Neutral turns required before sentiment shield decays. */
export const SENTIMENT_NEUTRAL_RECOVERY_TURNS = 2;
/** Absolute max age of frustration signal before auto-decay. */
export const SENTIMENT_FRUSTRATION_TTL_MS = 120_000;

export const SENTIMENT_SHIELD_SPEECH =
  "I apologize for the frustration. I want to make sure this gets resolved for you immediately. " +
  "I am escalating this conversation to a human agent, or I can provide you with our priority support number.";

export interface SentimentAnalysis {
  frustrated: boolean;
  matchedKeyword: string | null;
  frustrationCount: number;
  shieldArmed: boolean;
}

/** True when a payment batch / email confirmation is mid-flight — finish batch before Shield. */
export function isCheckoutBatchMidFlow(session?: CallSession): boolean {
  if (!session) return false;
  if (
    isEmailConfirmationActive(session) &&
    session.emailConfirmation?.workflowType === "payment_link"
  ) {
    return true;
  }
  const state = session.paymentCheckout?.state ?? "idle";
  if (state === "awaiting_email" || state === "awaiting_batch_email") {
    return true;
  }
  const cs = session.paymentCheckout?.checkoutSession;
  if (cs?.active && (cs.currentBatch?.length ?? 0) > 0) {
    return true;
  }
  return false;
}

export function analyzeFrustrationUtterance(text: string): {
  frustrated: boolean;
  matchedKeyword: string | null;
} {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return { frustrated: false, matchedKeyword: null };
  const match = trimmed.match(FRUSTRATION_KEYWORDS);
  return {
    frustrated: Boolean(match),
    matchedKeyword: match?.[0]?.toLowerCase() ?? null,
  };
}

/**
 * Analyze caller input, update frustrationCount, and decide whether to arm the Sentiment Shield.
 * Does NOT escalate while a payment batch is mid-flow — defers until the batch finishes.
 * Neutral turns + TTL decay clear the shield so checkout can resume (never permanent lock).
 */
export function analyzeAndTrackSentiment(
  session: CallSession,
  text: string,
): SentimentAnalysis {
  const memory = ensureSessionMemory(session);
  const { frustrated, matchedKeyword } = analyzeFrustrationUtterance(text);

  if (frustrated) {
    memory.frustrationCount = (memory.frustrationCount ?? 0) + 1;
    memory.lastFrustrationAt = Date.now();
    memory.neutralTurnStreak = 0;
    logger.info("sentiment_frustration_signal", {
      callSid: session.callSid.slice(0, 8),
      matchedKeyword,
      frustrationCount: memory.frustrationCount,
    });
  } else {
    memory.neutralTurnStreak = (memory.neutralTurnStreak ?? 0) + 1;
    maybeRecoverSentiment(session);
  }

  const count = memory.frustrationCount ?? 0;
  const overThreshold = count > SENTIMENT_SHIELD_THRESHOLD;
  const midBatch = isCheckoutBatchMidFlow(session);

  if (overThreshold && midBatch) {
    memory.pendingSentimentShield = true;
    logger.info("sentiment_shield_deferred_mid_checkout", {
      callSid: session.callSid.slice(0, 8),
      frustrationCount: count,
    });
    return {
      frustrated,
      matchedKeyword,
      frustrationCount: count,
      shieldArmed: false,
    };
  }

  if (overThreshold || memory.pendingSentimentShield) {
    memory.sentimentShieldActive = true;
    memory.pendingSentimentShield = false;
    // Stop sales / upsell immediately.
    session.pendingProactiveRecommendation = undefined;
    return {
      frustrated,
      matchedKeyword,
      frustrationCount: count,
      shieldArmed: true,
    };
  }

  return {
    frustrated,
    matchedKeyword,
    frustrationCount: count,
    shieldArmed: false,
  };
}

/** Decay shield after neutral turns or TTL — releases FlowMutex so checkout resumes. */
export function maybeRecoverSentiment(session: CallSession): boolean {
  const memory = ensureSessionMemory(session);
  if (!memory.sentimentShieldActive && !memory.pendingSentimentShield) return false;

  const agedOut =
    memory.lastFrustrationAt != null &&
    Date.now() - memory.lastFrustrationAt >= SENTIMENT_FRUSTRATION_TTL_MS;
  const neutralOk = (memory.neutralTurnStreak ?? 0) >= SENTIMENT_NEUTRAL_RECOVERY_TURNS;

  if (!agedOut && !neutralOk) return false;

  memory.sentimentShieldActive = false;
  memory.pendingSentimentShield = false;
  memory.frustrationCount = 0;
  memory.neutralTurnStreak = 0;
  // Drop FlowMutex ownership so checkout cannot stay in limbo after recovery.
  void import("../agents/flowMutex.js").then(({ releaseFlowMutex, getFlowMutex }) => {
    const owner = getFlowMutex(session).owner;
    if (owner === "sentiment_escalation" || owner === "support") {
      releaseFlowMutex(session);
    }
  });
  logger.info("sentiment_shield_recovered", {
    callSid: session.callSid.slice(0, 8),
    agedOut,
    neutralOk,
  });
  return true;
}

/**
 * Pure recommendation only. ActionGateway owns support case creation and webhook delivery.
 */
export function escalateToHuman(
  session: CallSession,
  reason = "sentiment_shield",
): { recommendEscalation: true; reason: string; ticketIdPreview: string } {
  const memory = ensureSessionMemory(session);
  memory.sentimentShieldActive = true;
  return {
    recommendEscalation: true,
    reason,
    ticketIdPreview: `HUM-${session.callSid.slice(0, 8)}-pending`,
  };
}

/** Fire deferred Shield after a checkout batch completes (or cart empties). */
export function flushPendingSentimentShield(session: CallSession): string | null {
  const memory = ensureSessionMemory(session);
  if (!memory.pendingSentimentShield && !((memory.frustrationCount ?? 0) > SENTIMENT_SHIELD_THRESHOLD)) {
    return null;
  }
  if (isCheckoutBatchMidFlow(session)) return null;

  memory.sentimentShieldActive = true;
  memory.pendingSentimentShield = false;
  session.pendingProactiveRecommendation = undefined;
  return SENTIMENT_SHIELD_SPEECH;
}

export const SentimentAnalyzer = {
  analyzeFrustrationUtterance,
  analyzeAndTrackSentiment,
  escalateToHuman,
  flushPendingSentimentShield,
  isCheckoutBatchMidFlow,
  SENTIMENT_SHIELD_THRESHOLD,
  SENTIMENT_SHIELD_SPEECH,
} as const;
