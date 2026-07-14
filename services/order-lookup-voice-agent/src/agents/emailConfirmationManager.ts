/**
 * Central Email Confirmation Engine — single state machine for all email workflows.
 * Used by support escalation and payment-link checkout (separate business flows).
 *
 * Clear yes / email extract / structured corrections stay deterministic for the
 * tool pipeline. Meta-instructions and ambiguous turns fall through to the LLM.
 */
import type { CallSession } from "../types/order.js";
import { logger } from "../utils/logger.js";
import {
  applyPartialCorrection,
  buildEmailConfirmationSpeech,
  buildUpdatedEmailConfirmationSpeech,
  extractEmailFromSpeech,
  isEmailConfirmation,
  isEmailRejection,
  isPartialEmailCorrection,
  isRequestSlowEmailRepeat,
  looksLikePartialEmail,
  parsePendingEmail,
  shouldAbortEmailConfirmation,
  isOrderContextSwitchUtterance,
  spellEmailLetterByLetterForTTS,
  type PendingEmail,
  type PartialCorrection,
} from "../utils/emailCapture.js";
import { isValidEmail as isValidCustomerEmail } from "../utils/emailUtils.js";
import type { ConfirmedEmail } from "../domain/checkoutModels.js";
import { ensureSessionMemory } from "./sessionMemory.js";
import { randomUUID } from "node:crypto";

export type EmailWorkflowType = "support_escalation" | "payment_link";

export type EmailConfirmationPhase =
  | "idle"
  | "collect_email"
  | "pending_confirmation"
  | "confirmed"
  | "completed";

export interface EmailConfirmationContext {
  workflowType: EmailWorkflowType;
  phase: EmailConfirmationPhase;
  latestRawEmail?: string;
  /** Normalized full address — mirrored into pendingEmailSlots. */
  normalizedEmail?: string;
  /**
   * Semantic slots for targeted PartialCorrection (part1 / part2 / domain).
   * SSOT for mid-confirmation segment repair — never force a full re-parse.
   */
  pendingEmailSlots?: PendingEmail;
  /** Last applied PartialCorrection (for speech / LLM context). */
  lastPartialCorrection?: PartialCorrection;
  confirmedEmail?: string;
  confirmationStatus: "pending" | "confirmed" | "rejected";
  sentStatus: "pending" | "sent" | "failed";
  sentTimestamp?: number;
}

function syncPendingEmailSlots(
  ctx: EmailConfirmationContext,
  email: string,
  correction?: PartialCorrection | null,
): PendingEmail {
  const slots = parsePendingEmail(email);
  ctx.normalizedEmail = slots.full;
  ctx.pendingEmailSlots = slots;
  if (correction) {
    ctx.lastPartialCorrection = correction;
  } else {
    ctx.lastPartialCorrection = undefined;
  }
  return slots;
}

export type EmailWorkflowExecutor = (
  session: CallSession,
  confirmedEmail: string,
) => Promise<{ ok: boolean; successSpeech: string; failureSpeech: string }>;

/** Issue opaque confirmed_email_id — only EmailConfirmationManager may create these. */
export function issueConfirmedEmail(
  session: CallSession,
  address: string,
  workflowType: EmailWorkflowType,
): ConfirmedEmail {
  const memory = ensureSessionMemory(session);
  if (!memory.confirmedEmails) memory.confirmedEmails = [];
  const record: ConfirmedEmail = {
    confirmedEmailId: `ce_${randomUUID().slice(0, 12)}`,
    address: address.trim().toLowerCase(),
    confirmedAt: Date.now(),
    workflowType,
  };
  memory.confirmedEmails.push(record);
  memory.latestConfirmedEmailId = record.confirmedEmailId;
  return record;
}

export function getConfirmedEmailById(
  session: CallSession,
  confirmedEmailId: string,
): ConfirmedEmail | undefined {
  const memory = ensureSessionMemory(session);
  return memory.confirmedEmails?.find((e) => e.confirmedEmailId === confirmedEmailId);
}

export function getLatestConfirmedEmailId(session: CallSession): string | undefined {
  return ensureSessionMemory(session).latestConfirmedEmailId;
}

const ASK_EMAIL_SPEECH =
  "What email address should we use? Please say it clearly, for example, your name at gmail dot com.";

const ASK_EMAIL_AGAIN_SPEECH =
  "I did not catch a complete email address. Please say your full email again slowly, including at and dot com.";

function isEmailPhaseUtterance(text: string): boolean {
  return (
    isEmailConfirmation(text) ||
    isEmailRejection(text) ||
    extractEmailFromSpeech(text) != null ||
    looksLikePartialEmail(text) ||
    isPartialEmailCorrection(text) ||
    isRequestSlowEmailRepeat(text)
  );
}

const workflowExecutors = new Map<EmailWorkflowType, EmailWorkflowExecutor>();

export function registerEmailWorkflowExecutor(
  workflowType: EmailWorkflowType,
  executor: EmailWorkflowExecutor,
): void {
  workflowExecutors.set(workflowType, executor);
}

function ensureEmailConfirmation(session: CallSession): EmailConfirmationContext {
  if (!session.emailConfirmation) {
    session.emailConfirmation = {
      workflowType: "support_escalation",
      phase: "idle",
      confirmationStatus: "pending",
      sentStatus: "pending",
    };
  }
  return session.emailConfirmation;
}

export function getEmailConfirmationPhase(session?: CallSession): EmailConfirmationPhase {
  return session?.emailConfirmation?.phase ?? "idle";
}

export function isEmailConfirmationActive(session?: CallSession): boolean {
  const phase = getEmailConfirmationPhase(session);
  return phase === "collect_email" || phase === "pending_confirmation";
}

export function isEmailConfirmationLocked(session?: CallSession): boolean {
  return isEmailConfirmationActive(session);
}

export function getActiveEmailWorkflowType(session?: CallSession): EmailWorkflowType | null {
  if (!session?.emailConfirmation || session.emailConfirmation.phase === "idle") return null;
  return session.emailConfirmation.workflowType;
}

export function startEmailCapture(
  session: CallSession,
  workflowType: EmailWorkflowType,
): void {
  const ctx = ensureEmailConfirmation(session);
  ctx.workflowType = workflowType;
  ctx.phase = "collect_email";
  ctx.latestRawEmail = undefined;
  ctx.normalizedEmail = undefined;
  ctx.pendingEmailSlots = undefined;
  ctx.lastPartialCorrection = undefined;
  ctx.confirmedEmail = undefined;
  ctx.confirmationStatus = "pending";
  ctx.sentStatus = "pending";
  ctx.sentTimestamp = undefined;
  logger.info("email_confirmation_started", {
    callSid: session.callSid.slice(0, 8),
    workflowType,
  });
}

export function resetEmailConfirmation(session: CallSession): void {
  session.emailConfirmation = {
    workflowType: "support_escalation",
    phase: "idle",
    confirmationStatus: "pending",
    sentStatus: "pending",
  };
}

/** Clear email capture and release any locked workflow without scolding the caller. */
export function abortEmailConfirmationFlow(session: CallSession): void {
  const workflow = session.emailConfirmation?.workflowType;
  resetEmailConfirmation(session);

  if (workflow === "support_escalation" && session.supportEscalation) {
    session.supportEscalation.state = "normal";
    session.supportEscalation.requestedInfo = "protected information";
    session.supportEscalation.escalationReason = "Caller pivoted away from support.";
    session.supportEscalation.issueDescription = undefined;
    logger.info("support_escalation_cancelled_via_email_abort", {
      callSid: session.callSid.slice(0, 8),
    });
  }

  if (workflow === "payment_link" && session.paymentCheckout?.state === "awaiting_email") {
    session.paymentCheckout.state = "idle";
  }
}

export function buildEmailCapturePrompt(workflowType: EmailWorkflowType): string {
  if (workflowType === "payment_link") {
    return `To send your secure payment link, ${ASK_EMAIL_SPEECH}`;
  }
  return ASK_EMAIL_SPEECH;
}

/**
 * LLM / tool path — update pending email on UnifiedCallSession without restarting
 * the support_escalation or payment_link workflow.
 * Supports Semantic Slot PartialCorrection via replaceFrom/replaceTo or explicit slot.
 */
export function updatePendingEmail(
  session: CallSession,
  email: string,
  rawUtterance?: string,
  options?: {
    replaceFrom?: string;
    replaceTo?: string;
    /** Target semantic slot for PartialCorrection (defaults to inferred). */
    slot?: PartialCorrection["slot"];
  },
): { ok: true; email: string; spelled: string; pending: PendingEmail; correction?: PartialCorrection }
  | { ok: false; error: string } {
  const ctx = ensureEmailConfirmation(session);
  const from = (options?.replaceFrom ?? "").trim().toLowerCase();
  const to = (options?.replaceTo ?? "").trim().toLowerCase();
  let normalized = email.trim().toLowerCase();
  let correction: PartialCorrection | undefined;

  if (from && to) {
    const base = (ctx.normalizedEmail ?? normalized).toLowerCase();
    if (!base.includes("@")) {
      return { ok: false, error: "No cached email to patch — collect the full address first." };
    }
    const before = ctx.pendingEmailSlots ?? parsePendingEmail(base);
    normalized = base.includes(from) ? base.split(from).join(to) : base;
    const after = parsePendingEmail(normalized);
    correction = {
      slot: options?.slot ?? inferSlotFromPatch(before, after, from, to),
      from,
      to,
    };
  }

  if (!isValidCustomerEmail(normalized)) {
    return { ok: false, error: "Valid email address required." };
  }
  ctx.phase = "pending_confirmation";
  ctx.latestRawEmail = (rawUtterance ?? (email || normalized)).trim();
  const pending = syncPendingEmailSlots(ctx, normalized, correction);
  ctx.confirmedEmail = undefined;
  ctx.confirmationStatus = "pending";
  logger.info("email_pending_updated", {
    callSid: session.callSid.slice(0, 8),
    workflowType: ctx.workflowType,
    emailDomain: pending.domain || "unknown",
    segmentRepair: Boolean(from && to),
    slot: correction?.slot,
  });
  return {
    ok: true,
    email: pending.full,
    spelled: spellEmailLetterByLetterForTTS(pending.full),
    pending,
    correction,
  };
}

function inferSlotFromPatch(
  before: PendingEmail,
  after: PendingEmail,
  from: string,
  to: string,
): PartialCorrection["slot"] {
  if (before.part2.includes(from) && after.part2.includes(to)) return "part2";
  if (before.part1.includes(from) && after.part1.includes(to)) return "part1";
  if (before.domain.includes(from) && after.domain.includes(to)) return "domain";
  if (before.domain !== after.domain) return "domain";
  return "local";
}

function captureEmailFromSpeech(
  session: CallSession,
  text: string,
): { handled: true; speech: string } | { handled: false } {
  const ctx = ensureEmailConfirmation(session);
  const email = extractEmailFromSpeech(text);
  if (email && isValidCustomerEmail(email)) {
    ctx.latestRawEmail = text;
    syncPendingEmailSlots(ctx, email);
    ctx.phase = "pending_confirmation";
    logger.info("email_extracted", {
      callSid: session.callSid.slice(0, 8),
      workflowType: ctx.workflowType,
      emailDomain: email.split("@")[1] ?? "unknown",
    });
    const speech = buildEmailConfirmationSpeech(email);
    logger.info("email_confirmation_requested", {
      callSid: session.callSid.slice(0, 8),
      workflowType: ctx.workflowType,
    });
    return { handled: true, speech };
  }
  if (looksLikePartialEmail(text) || isPartialEmailCorrection(text)) {
    return { handled: true, speech: ASK_EMAIL_AGAIN_SPEECH };
  }
  // Meta-instructions / unrelated turns → LLM (no rigid "finish first" lock).
  return { handled: false };
}

async function confirmAndSend(
  session: CallSession,
): Promise<{ handled: true; speech: string }> {
  const ctx = ensureEmailConfirmation(session);
  const email = ctx.normalizedEmail ?? ctx.confirmedEmail;
  if (!email || !isValidCustomerEmail(email)) {
    ctx.phase = "collect_email";
    return { handled: true, speech: ASK_EMAIL_AGAIN_SPEECH };
  }

  ctx.confirmedEmail = email;
  ctx.confirmationStatus = "confirmed";
  ctx.phase = "confirmed";
  issueConfirmedEmail(session, email, ctx.workflowType);

  const executor = workflowExecutors.get(ctx.workflowType);
  if (!executor) {
    ctx.sentStatus = "failed";
    return {
      handled: true,
      speech: "I am sorry, but I cannot complete this email request right now. Please try again shortly.",
    };
  }

  const result = await executor(session, email);
  if (result.ok) {
    ctx.sentStatus = "sent";
    ctx.sentTimestamp = Date.now();
    ctx.phase = "completed";
    logger.info("email_workflow_sent", {
      callSid: session.callSid.slice(0, 8),
      workflowType: ctx.workflowType,
    });
    return { handled: true, speech: result.successSpeech };
  }

  ctx.sentStatus = "failed";
  ctx.phase = "collect_email";
  ctx.normalizedEmail = undefined;
  ctx.pendingEmailSlots = undefined;
  ctx.lastPartialCorrection = undefined;
  ctx.confirmedEmail = undefined;
  return { handled: true, speech: result.failureSpeech };
}

/**
 * Email-confirmation turn — handles clear capture / confirm / structured corrections.
 * Ambiguous and meta utterances return handled:false so the LLM receives raw input.
 */
export async function resolveEmailConfirmationTurn(
  session: CallSession,
  callerText: string,
): Promise<{ handled: true; speech: string } | { handled: false }> {
  const text = (callerText ?? "").trim();
  if (!text) return { handled: false };

  const ctx = session.emailConfirmation;
  if (!ctx || ctx.phase === "idle" || ctx.phase === "completed") {
    return { handled: false };
  }

  if (shouldAbortEmailConfirmation(text) || isOrderContextSwitchUtterance(text)) {
    abortEmailConfirmationFlow(session);
    return { handled: false };
  }

  if (ctx.phase === "collect_email") {
    return captureEmailFromSpeech(session, text);
  }

  if (ctx.phase === "pending_confirmation") {
    if (isEmailRejection(text)) {
      const structured =
        ctx.normalizedEmail ? applyPartialCorrection(ctx.normalizedEmail, text) : null;
      const corrected =
        extractEmailFromSpeech(text) ?? structured?.email ?? null;
      if (corrected && isValidCustomerEmail(corrected)) {
        ctx.latestRawEmail = text;
        syncPendingEmailSlots(ctx, corrected, structured?.correction);
        ctx.confirmationStatus = "pending";
        return {
          handled: true,
          speech: buildUpdatedEmailConfirmationSpeech(corrected, structured?.correction),
        };
      }
      ctx.phase = "collect_email";
      ctx.normalizedEmail = undefined;
      ctx.pendingEmailSlots = undefined;
      ctx.lastPartialCorrection = undefined;
      ctx.latestRawEmail = undefined;
      ctx.confirmationStatus = "rejected";
      return { handled: true, speech: buildEmailCapturePrompt(ctx.workflowType) };
    }

    if (isEmailConfirmation(text)) {
      return confirmAndSend(session);
    }

    if (isRequestSlowEmailRepeat(text) && ctx.normalizedEmail) {
      return { handled: true, speech: buildEmailConfirmationSpeech(ctx.normalizedEmail) };
    }

    if (isPartialEmailCorrection(text) && ctx.normalizedEmail) {
      const structured = applyPartialCorrection(ctx.normalizedEmail, text);
      const corrected = structured?.email ?? extractEmailFromSpeech(text);
      if (corrected && isValidCustomerEmail(corrected)) {
        ctx.latestRawEmail = text;
        syncPendingEmailSlots(ctx, corrected, structured?.correction);
        return {
          handled: true,
          speech: buildUpdatedEmailConfirmationSpeech(corrected, structured?.correction),
        };
      }
      // Unstructured correction ("Bashi not Basi", "don't read it like that") → LLM.
      return { handled: false };
    }

    const corrected = extractEmailFromSpeech(text);
    if (corrected && isValidCustomerEmail(corrected)) {
      ctx.latestRawEmail = text;
      syncPendingEmailSlots(ctx, corrected);
      return { handled: true, speech: buildUpdatedEmailConfirmationSpeech(corrected) };
    }

    // Meta-instructions, formatting complaints, fuzzy name fixes → LLM.
    return { handled: false };
  }

  return { handled: false };
}

/**
 * @deprecated Interruption lock removed — meta turns defer to the LLM.
 * Kept as a no-op for callers that still import it.
 */
export function blockDuringEmailConfirmation(
  _session: CallSession,
  _callerText: string,
): string | null {
  return null;
}

/** System context for the LLM while email capture is active. */
export function buildEmailConfirmationSystemMessage(session: CallSession): string | null {
  if (!isEmailConfirmationActive(session) || !session.emailConfirmation) return null;
  const ctx = session.emailConfirmation;
  const pending = ctx.normalizedEmail?.trim() ?? "";
  const slots = ctx.pendingEmailSlots ?? (pending ? parsePendingEmail(pending) : null);
  const spelled = pending ? spellEmailLetterByLetterForTTS(pending) : "(none yet)";
  const workflow =
    ctx.workflowType === "payment_link" ? "payment_link checkout" : "support_escalation";
  const slotLine = slots
    ? `pendingEmailSlots: part1=${slots.part1 || "(empty)"} part2=${slots.part2 || "(empty)"} domain=${slots.domain || "(empty)"}`
    : "pendingEmailSlots: (none yet)";
  const lastFix = ctx.lastPartialCorrection
    ? `lastPartialCorrection: slot=${ctx.lastPartialCorrection.slot} ${ctx.lastPartialCorrection.from}→${ctx.lastPartialCorrection.to}`
    : "lastPartialCorrection: (none)";

  return [
    "EMAIL CONFIRMATION IN PROGRESS (MANDATORY — SEMANTIC SLOT REPAIR)",
    `workflow: ${workflow}`,
    `phase: ${ctx.phase}`,
    `pendingEmail: ${pending || "(awaiting address)"}`,
    slotLine,
    lastFix,
    `pendingEmailSpelled: ${spelled}`,
    "The caller's raw utterance is authoritative. Honor meta-instructions (e.g. change formatting, fix a letter, start over, 'don't read it like that').",
    "When confirming an email, read it STRICTLY letter-by-letter with short pauses (e.g. B, A, S, H, I at gmail dot com). NEVER use 'A as in Apple' phonetic cue words for email.",
    "SEMANTIC SLOT PartialCorrection: If the caller says 'No, it's Saab', patch ONLY the matching slot (usually part2) via update_pending_email with replace_from/replace_to — do NOT re-ask for the entire email.",
    "Acknowledge the corrected slot only: 'Understood. I have updated the spelling to S-A-A-B. Your email is now … Is that correct?' then read the FULL updated email once letter-by-letter.",
    "Do NOT say you must finish confirming email before helping — apply their correction or instruction immediately.",
    "Only after they explicitly confirm the spelled email, call send_checkout_email (or initiate_checkout_batch first for split batches) or send_support_escalation as appropriate for this workflow.",
  ].join("\n");
}

export { isEmailPhaseUtterance };
