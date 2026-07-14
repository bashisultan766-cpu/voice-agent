/**
 * SessionMemory — preserves the caller's initial goal across the whole call.
 * Never drops a stated intent (e.g. tracking ID) after order number collection or lookup.
 */
import type { CallSession } from "../types/order.js";
import { TRACKING_REQUEST_RE } from "./trackingIntent.js";

export type BufferedSessionIntent =
  | "order_lookup"
  | "tracking_id"
  | "order_status"
  | "general";

export interface SessionMemoryState {
  initialIntent: BufferedSessionIntent | null;
  pendingGoal: BufferedSessionIntent | null;
  /** Latest classified intent for the brain. */
  currentIntent?: string;
  /** Active workflow label from agent brain. */
  activeWorkflow?: string;
  /** Last user utterance (trimmed). */
  lastUserRequest?: string;
  /** Open goal the brain is still resolving. */
  unresolvedUserGoal?: string | null;
  /** Last successful catalog product memory. */
  lastProductTitle?: string;
  lastProductId?: string;
  lastProductPrice?: string;
  lastProductIsbn?: string;
  latestQuantityRequested?: number;
  /**
   * True after the agent asked "How many copies?" — next bare number/"one" is a Confirmation Turn.
   * Cleared once quantity is applied; if the user repeats the same answer, accept immediately.
   */
  awaitingQuantityReply?: boolean;
  /** How many times we've asked for quantity this product turn (max ask-once, then accept). */
  quantityAskCount?: number;
  /** Cumulative frustration keyword hits this call (Sentiment Shield). */
  frustrationCount?: number;
  /** True when Sentiment Shield is active — no sales/upsell; Support-Mode only. */
  sentimentShieldActive?: boolean;
  /** Frustration crossed threshold during a mid-flight payment batch — escalate after batch. */
  pendingSentimentShield?: boolean;
  /** Mock escalate_to_human already fired this call. */
  humanEscalationTriggered?: boolean;
  /** FlowMutex owner for Sentiment vs Checkout unification. */
  flowMutex?: {
    owner: "none" | "sentiment_escalation" | "checkout" | "support";
    ownerId?: string;
    leaseToken?: string;
    acquiredAt: number;
    expiresAt?: number;
    reason?: string;
    stateVersion?: number;
  };
  /**
   * LISTENING_WAIT buffer — partial transcript held until Wait-for-Clause says the turn is complete.
   */
  listeningWaitBuffer?: string;
  /** Epoch ms when LISTENING_WAIT was entered — used for progressive prompts / recovery. */
  listeningWaitEnteredAt?: number;
  /** How many progressive wait prompts have been spoken this wait episode. */
  listeningWaitPromptCount?: number;
  listeningWait?: {
    waitId: string;
    reason: string;
    startedAt: number;
    promptStage: number;
  };
  /** Prevent duplicate transport/session teardown. */
  terminationCompleted?: boolean;
  supportCases?: Array<{
    caseId: string;
    reason: string;
    createdAt: number;
    issueSummary?: string;
    verificationLevel: "verified" | "unverified";
    emailSent?: boolean;
    webhookNotified?: boolean;
    notificationAttemptedAt?: number;
    /** Idempotency metadata — invisible to the LLM. */
    requestId?: string;
    payloadFingerprint?: string;
    /** In-flight notify promise — cleared after settle (never serialized as data). */
    notificationPromise?: Promise<{ emailSent: boolean; webhookNotified: boolean }>;
  }>;
  /**
   * Last persisted facility eligibility decision. Cart-add and checkout must
   * consume the same policyVersion; raw logistics payloads never live here.
   */
  facilityEligibility?: {
    decision: "allow" | "restrict";
    reason?: string;
    policyVersion: string;
    at: number;
  };
  /** CheckoutPlan SSOT for split / full cart payment groups. */
  checkoutPlan?: import("../domain/checkoutModels.js").CheckoutPlan;
  /** Confirmed emails issued by EmailConfirmationManager this call. */
  confirmedEmails?: import("../domain/checkoutModels.js").ConfirmedEmail[];
  /** Most recent confirmed_email_id for checkout binding. */
  latestConfirmedEmailId?: string;
  /** Most recent checkout_group_id from initiate_checkout_batch. */
  latestCheckoutGroupId?: string;
  /** Last tool FAILURE_STATE — must be acknowledged before retry (no dual/fallback paths). */
  lastFailureState?: {
    code: string;
    message: string;
    tool?: string;
    recordedAt: number;
  };
  /** True after caller acknowledged lastFailureState. */
  failureAcknowledged?: boolean;
  /** Sentiment last frustration epoch — used for neutral-turn decay. */
  lastFrustrationAt?: number;
  /** Consecutive neutral (non-frustrated) turns since last frustration. */
  neutralTurnStreak?: number;
  lastOrderNumber?: string;
  verificationStatus?: "verified" | "non_verified";
  supportEscalationStatus?: string;
  emailConfirmationStatus?: string;
  paymentLinkStatus?: string;
  /**
   * Cached inventory decisions from InventoryResolutionService — cart and
   * checkout consume this instead of re-running raw provider calls.
   */
  inventoryDecisions?: {
    entries: Record<string, import("./inventoryResolutionService.js").InventoryResolution>;
  };
  /**
   * Last email_unknown reconciliation hint — avoids forcing cart re-plan when
   * an invoice/draft already exists.
   */
  emailUnknownReconcile?: {
    checkoutGroupId: string;
    invoicePending: boolean;
    checkedAt: number;
  };
  /**
   * Durable ActiveSession / dictation snapshot (JSONB-friendly).
   * Survives process restart — tracking digits live here (not OrderView L2,
   * which redacts tracking_number for disclosure safety).
   */
  metadata?: SessionDictationMetadata;
}

/**
 * Serialized notepad / tracking dictation state restored into ActiveSession
 * on hydrate. Persisted inside call_sessions.session_json → sessionMemory.metadata.
 */
export interface SessionDictationMetadata {
  tracking_number?: string;
  tracking_number_for_tts?: string;
  notepad_content?: string;
  spatial_index?: Array<{ index: number; digit: string }>;
  last_spoken_index?: number;
  last_dictation_index?: number;
  is_tracking_in_progress?: boolean;
  is_notepad_ready?: boolean;
  tracking_dictation_complete?: boolean;
  current_state?: string;
  cached_intent?: string | null;
  awaiting_clarification?: string | null;
  last_spoken_payload?: {
    kind: "tracking" | "order_status" | "catalog" | "cart" | "general";
    speech: string;
    trackingForTts?: string;
    trackingRaw?: string;
    toolName?: string;
    intentKey?: string;
    capturedAt: number;
  } | null;
  last_spoken_data_point?: {
    kind: "tracking_number" | "order_number" | "email" | "other";
    raw: string;
    forTts: string;
    capturedAt: number;
  } | null;
  /** Monotonic bump for idempotent L1 merges / optimistic awareness. */
  metadata_version?: number;
  updated_at?: number;
}

const EMPTY: SessionMemoryState = { initialIntent: null, pendingGoal: null };

function ensureMemory(session: CallSession): SessionMemoryState {
  if (!session.sessionMemory) {
    session.sessionMemory = { ...EMPTY };
  }
  return session.sessionMemory;
}

export function getSessionMemory(session: CallSession): SessionMemoryState {
  return session.sessionMemory ?? EMPTY;
}

/** Always returns a mutable session-owned memory object (never the shared EMPTY stub). */
export function ensureSessionMemory(session: CallSession): SessionMemoryState {
  return ensureMemory(session);
}

/** Infer buffered intent from utterance before tools run. */
export function inferBufferedIntentFromSpeech(
  text: string,
  classifiedIntent?: string,
): BufferedSessionIntent | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;

  if (TRACKING_REQUEST_RE.test(trimmed) || /\btracking\s*(?:i\.?d\.?|it|i\s*t)\b/i.test(trimmed)) {
    return "tracking_id";
  }
  if (
    classifiedIntent === "order_lookup" ||
    /\b(order\s+status|where\s+is\s+my\s+order|track\s+my\s+order|my\s+order)\b/i.test(trimmed)
  ) {
    return "order_lookup";
  }
  if (classifiedIntent === "product_search" || classifiedIntent === "isbn_query") {
    return null;
  }
  return null;
}

/**
 * Capture the caller's first stated goal — only set once per call unless pendingGoal was cleared.
 */
export function captureSessionIntent(
  session: CallSession,
  text: string,
  classifiedIntent?: string,
): SessionMemoryState {
  const memory = ensureMemory(session);
  const inferred = inferBufferedIntentFromSpeech(text, classifiedIntent);
  if (!inferred) return memory;

  if (!memory.initialIntent) {
    memory.initialIntent = inferred;
  }
  if (!memory.pendingGoal) {
    memory.pendingGoal = inferred;
  }
  return memory;
}

export function markSessionGoalFulfilled(
  session: CallSession,
  goal: BufferedSessionIntent,
): void {
  const memory = ensureMemory(session);
  if (memory.pendingGoal === goal) {
    memory.pendingGoal = null;
  }
}

export function callerAskedForTracking(session: CallSession): boolean {
  const memory = getSessionMemory(session);
  return memory.initialIntent === "tracking_id" || memory.pendingGoal === "tracking_id";
}

export function clearSessionMemory(session: CallSession): void {
  session.sessionMemory = { ...EMPTY };
}
