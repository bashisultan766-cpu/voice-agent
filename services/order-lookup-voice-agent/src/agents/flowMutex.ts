/**
 * FlowMutex — ownership + TTL + finally-based release.
 *
 * Canonical critical-section API: `FlowMutex.withLock` / `withFlowMutex`.
 * Manual acquire/release remain for durable sentiment ownership after a
 * successful escalation, but short critical sections MUST use withLock so
 * developers cannot forget to release (try/finally lives inside the utility).
 *
 * Sentiment must NEVER permanently own a transaction lock (TTL + 120s stale breaker).
 */
import type { CallSession } from "../types/order.js";
import { ensureSessionMemory } from "./sessionMemory.js";
import { getUnifiedSession } from "./unifiedCallSession.js";
import { logger } from "../utils/logger.js";
import { randomUUID } from "node:crypto";

export type FlowMutexOwner = "none" | "sentiment_escalation" | "checkout" | "support";

/** Sentiment escalation lock auto-expires so checkout can resume. */
export const SENTIMENT_MUTEX_TTL_MS = 90_000;
export const CHECKOUT_MUTEX_TTL_MS = 120_000;
/** Hard ceiling — any lock held longer is force-released on turn entry. */
export const STALE_LOCK_MAX_MS = 120_000;

export const ESCALATION_FAILURE_SPEECH =
  "I'm sorry, I couldn't escalate right now, please try again.";

export interface FlowMutexState {
  owner: FlowMutexOwner;
  ownerId?: string;
  leaseToken?: string;
  acquiredAt: number;
  expiresAt: number;
  reason?: string;
  stateVersion?: number;
}

export interface FlowMutexLease {
  leaseToken: string;
  ownerId: string;
}

function mutexBucket(session: CallSession): FlowMutexState {
  const memory = ensureSessionMemory(session);
  if (!memory.flowMutex) {
    memory.flowMutex = { owner: "none", acquiredAt: 0, expiresAt: 0, stateVersion: 0 };
  }
  if (memory.flowMutex.expiresAt === undefined) {
    (memory.flowMutex as FlowMutexState).expiresAt = 0;
  }
  return memory.flowMutex as FlowMutexState;
}

function ttlFor(owner: FlowMutexOwner): number {
  if (owner === "sentiment_escalation") return SENTIMENT_MUTEX_TTL_MS;
  if (owner === "checkout") return CHECKOUT_MUTEX_TTL_MS;
  if (owner === "support") return SENTIMENT_MUTEX_TTL_MS;
  return SENTIMENT_MUTEX_TTL_MS;
}

/** Clear shield flags that must not outlive mutex ownership. */
export function clearEscalationShieldFlags(session: CallSession): void {
  const memory = ensureSessionMemory(session);
  memory.sentimentShieldActive = false;
  memory.humanEscalationTriggered = false;
}

function forceReleaseFlowMutex(session: CallSession, reason: string): void {
  const m = mutexBucket(session);
  const priorOwner = m.owner;
  m.owner = "none";
  m.ownerId = undefined;
  m.leaseToken = undefined;
  m.reason = undefined;
  m.expiresAt = 0;
  m.acquiredAt = 0;
  clearEscalationShieldFlags(session);
  logger.info("flow_mutex_force_released", {
    call_id: session.callSid.slice(0, 12),
    priorOwner,
    reason,
  });
}

/**
 * Stale-lock breaker + TTL expiry.
 * Checked on every turn entry — locks held > STALE_LOCK_MAX_MS are force-released.
 */
export function refreshFlowMutexExpiry(session: CallSession): void {
  const m = mutexBucket(session);
  if (m.owner === "none") {
    // Flag without ownership is Checkout Limbo — clear it.
    const memory = ensureSessionMemory(session);
    if (memory.humanEscalationTriggered || memory.sentimentShieldActive) {
      clearEscalationShieldFlags(session);
    }
    return;
  }

  const now = Date.now();
  const heldMs = m.acquiredAt > 0 ? now - m.acquiredAt : 0;
  const stale = heldMs >= STALE_LOCK_MAX_MS;
  const ttlExpired = m.expiresAt > 0 && now > m.expiresAt;

  if (stale) {
    logger.info(
      `[MutexStaleRelease] callSid=${session.callSid} owner=${m.owner} heldMs=${heldMs}`,
      {
        callSid: session.callSid.slice(0, 8),
        owner: m.owner,
        heldMs,
        reason: m.reason,
      },
    );
    forceReleaseFlowMutex(session, "stale_lock_breaker");
    return;
  }

  if (ttlExpired) {
    logger.info("flow_mutex_expired", {
      call_id: session.callSid.slice(0, 12),
      owner: m.owner,
      reason: m.reason,
    });
    forceReleaseFlowMutex(session, "ttl_expired");
  }
}

/** Turn-entry hook — always run before processing caller text. */
export function onTurnFlowMutexCheck(session: CallSession): void {
  refreshFlowMutexExpiry(session);
}

export function isSentimentEscalationActive(session: CallSession): boolean {
  refreshFlowMutexExpiry(session);
  const memory = ensureSessionMemory(session);
  const m = mutexBucket(session);
  // Flags only count when mutex ownership is still held.
  if (m.owner === "none") return false;
  return Boolean(memory.sentimentShieldActive || memory.humanEscalationTriggered);
}

export function acquireFlowMutex(
  session: CallSession,
  owner: Exclude<FlowMutexOwner, "none">,
  reason?: string,
): FlowMutexLease {
  refreshFlowMutexExpiry(session);
  const m = mutexBucket(session);
  const ownerId = `${owner}:${session.callSid.slice(0, 8)}:${randomUUID().slice(0, 8)}`;
  const leaseToken = randomUUID();
  m.owner = owner;
  m.ownerId = ownerId;
  m.leaseToken = leaseToken;
  m.acquiredAt = Date.now();
  m.expiresAt = Date.now() + ttlFor(owner);
  m.reason = reason ?? owner;
  m.stateVersion = (m.stateVersion ?? 0) + 1;
  if (owner === "sentiment_escalation" || owner === "support") {
    ensureSessionMemory(session).sentimentShieldActive = true;
  }
  return { leaseToken, ownerId };
}

/** @deprecated Prefer acquireFlowMutex("sentiment_escalation") — kept as thin alias. */
export function acquireSentimentEscalationLock(
  session: CallSession,
  reason?: string,
): FlowMutexLease {
  return acquireFlowMutex(session, "sentiment_escalation", reason ?? "sentiment_shield");
}

export function releaseFlowMutex(session: CallSession, leaseToken?: string): void {
  const m = mutexBucket(session);
  if (m.owner === "none") {
    clearEscalationShieldFlags(session);
    return;
  }
  if (leaseToken && m.leaseToken !== leaseToken) {
    logger.warn("flow_mutex_release_token_mismatch", {
      call_id: session.callSid.slice(0, 12),
      expected: leaseToken?.slice(0, 8),
      actual: m.owner,
    });
    return;
  }
  const wasEscalation = m.owner === "sentiment_escalation" || m.owner === "support";
  m.owner = "none";
  m.ownerId = undefined;
  m.leaseToken = undefined;
  m.reason = undefined;
  m.expiresAt = 0;
  m.acquiredAt = 0;
  if (wasEscalation) {
    clearEscalationShieldFlags(session);
  }
}

export function renewFlowMutex(session: CallSession, leaseToken: string): boolean {
  refreshFlowMutexExpiry(session);
  const m = mutexBucket(session);
  if (m.leaseToken !== leaseToken || m.owner === "none") return false;
  m.expiresAt = Date.now() + ttlFor(m.owner);
  return true;
}

export function assertLeaseValid(session: CallSession, leaseToken: string): void {
  refreshFlowMutexExpiry(session);
  if (mutexBucket(session).leaseToken !== leaseToken) {
    throw new Error("FLOW_MUTEX_LEASE_INVALID");
  }
}

/**
 * Finally-safe critical section — ALWAYS releases on exit (success, throw, return).
 * Prefer this over manual acquire/release for any scoped work.
 */
export async function withFlowMutex<T>(
  session: CallSession,
  owner: Exclude<FlowMutexOwner, "none">,
  reason: string,
  fn: (lease: FlowMutexLease) => Promise<T> | T,
): Promise<T> {
  const lease = acquireFlowMutex(session, owner, reason);
  try {
    return await fn(lease);
  } finally {
    releaseFlowMutex(session, lease.leaseToken);
  }
}

/**
 * CallSid-scoped withLock — resolves UnifiedCallSession then runs withFlowMutex.
 * This is the preferred entry point so call sites cannot skip the finally release.
 */
export async function withLock<T>(
  callSid: string,
  owner: Exclude<FlowMutexOwner, "none">,
  reason: string,
  fn: (lease: FlowMutexLease, session: CallSession) => Promise<T> | T,
): Promise<T> {
  const session = getUnifiedSession(callSid);
  if (!session) {
    throw new Error(`FLOW_MUTEX_NO_SESSION:${callSid.slice(0, 12)}`);
  }
  return withFlowMutex(session, owner, reason, (lease) => fn(lease, session));
}

/**
 * Checkout gate: humanEscalationTriggered alone does NOT block — mutex must be held.
 * Stale / orphaned flags are cleared by refreshFlowMutexExpiry.
 */
export function isCheckoutPassiveReadOnly(session: CallSession): boolean {
  refreshFlowMutexExpiry(session);
  const m = mutexBucket(session);
  const memory = ensureSessionMemory(session);

  if (memory.humanEscalationTriggered && m.owner === "none") {
    // Orphan flag without mutex — never block checkout (Checkout Limbo guard).
    clearEscalationShieldFlags(session);
    return false;
  }

  if (m.owner === "sentiment_escalation" || m.owner === "support") {
    return Boolean(memory.sentimentShieldActive || memory.humanEscalationTriggered);
  }
  return false;
}

export function getFlowMutex(session: CallSession): FlowMutexState {
  refreshFlowMutexExpiry(session);
  return { ...mutexBucket(session) };
}

/** Session teardown — drop ownership + shield flags. */
export function clearFlowMutexOnSessionEnd(session: CallSession): void {
  forceReleaseFlowMutex(session, "session_end");
}

export const FlowMutex = {
  acquire: acquireFlowMutex,
  acquireSentimentEscalationLock,
  release: releaseFlowMutex,
  releaseFlowMutex,
  withFlowMutex,
  withLock,
  isCheckoutPassiveReadOnly,
  isSentimentEscalationActive,
  getFlowMutex,
  refreshFlowMutexExpiry,
  onTurnFlowMutexCheck,
  renewFlowMutex,
  assertLeaseValid,
  clearEscalationShieldFlags,
  clearFlowMutexOnSessionEnd,
  SENTIMENT_MUTEX_TTL_MS,
  CHECKOUT_MUTEX_TTL_MS,
  STALE_LOCK_MAX_MS,
  ESCALATION_FAILURE_SPEECH,
} as const;
