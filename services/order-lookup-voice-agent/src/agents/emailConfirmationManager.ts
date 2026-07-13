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
  applyPartialEmailCorrection,
  buildEmailConfirmationSpeech,
  buildUpdatedEmailConfirmationSpeech,
  extractEmailFromSpeech,
  isEmailConfirmation,
  isEmailRejection,
  isPartialEmailCorrection,
  isRequestSlowEmailRepeat,
  looksLikePartialEmail,
  shouldAbortEmailConfirmation,
  isOrderContextSwitchUtterance,
  spellEmailLetterByLetterForTTS,
} from "../utils/emailCapture.js";
import { isValidCustomerEmail } from "../utils/resendEmailService.js";

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
  normalizedEmail?: string;
  confirmedEmail?: string;
  confirmationStatus: "pending" | "confirmed" | "rejected";
  sentStatus: "pending" | "sent" | "failed";
  sentTimestamp?: number;
}

export type EmailWorkflowExecutor = (
  session: CallSession,
  confirmedEmail: string,
) => Promise<{ ok: boolean; successSpeech: string; failureSpeech: string }>;

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
 * Supports contextual segment repair via replaceFrom/replaceTo without re-asking the full address.
 */
export function updatePendingEmail(
  session: CallSession,
  email: string,
  rawUtterance?: string,
  options?: { replaceFrom?: string; replaceTo?: string },
): { ok: true; email: string; spelled: string } | { ok: false; error: string } {
  const ctx = ensureEmailConfirmation(session);
  const from = (options?.replaceFrom ?? "").trim().toLowerCase();
  const to = (options?.replaceTo ?? "").trim().toLowerCase();
  let normalized = email.trim().toLowerCase();

  if (from && to) {
    const base = (ctx.normalizedEmail ?? normalized).toLowerCase();
    if (!base.includes("@")) {
      return { ok: false, error: "No cached email to patch — collect the full address first." };
    }
    normalized = base.includes(from) ? base.split(from).join(to) : base;
  }

  if (!isValidCustomerEmail(normalized)) {
    return { ok: false, error: "Valid email address required." };
  }
  ctx.phase = "pending_confirmation";
  ctx.latestRawEmail = (rawUtterance ?? (email || normalized)).trim();
  ctx.normalizedEmail = normalized;
  ctx.confirmedEmail = undefined;
  ctx.confirmationStatus = "pending";
  logger.info("email_pending_updated", {
    callSid: session.callSid.slice(0, 8),
    workflowType: ctx.workflowType,
    emailDomain: normalized.split("@")[1] ?? "unknown",
    segmentRepair: Boolean(from && to),
  });
  return {
    ok: true,
    email: normalized,
    spelled: spellEmailLetterByLetterForTTS(normalized),
  };
}

function captureEmailFromSpeech(
  session: CallSession,
  text: string,
): { handled: true; speech: string } | { handled: false } {
  const ctx = ensureEmailConfirmation(session);
  const email = extractEmailFromSpeech(text);
  if (email && isValidCustomerEmail(email)) {
    ctx.latestRawEmail = text;
    ctx.normalizedEmail = email;
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
      const corrected =
        extractEmailFromSpeech(text) ??
        (ctx.normalizedEmail
          ? applyPartialEmailCorrection(ctx.normalizedEmail, text)
          : null);
      if (corrected && isValidCustomerEmail(corrected)) {
        ctx.latestRawEmail = text;
        ctx.normalizedEmail = corrected;
        ctx.confirmationStatus = "pending";
        return { handled: true, speech: buildUpdatedEmailConfirmationSpeech(corrected) };
      }
      ctx.phase = "collect_email";
      ctx.normalizedEmail = undefined;
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
      const corrected =
        applyPartialEmailCorrection(ctx.normalizedEmail, text) ?? extractEmailFromSpeech(text);
      if (corrected && isValidCustomerEmail(corrected)) {
        ctx.latestRawEmail = text;
        ctx.normalizedEmail = corrected;
        return { handled: true, speech: buildUpdatedEmailConfirmationSpeech(corrected) };
      }
      // Unstructured correction ("Bashi not Basi", "don't read it like that") → LLM.
      return { handled: false };
    }

    const corrected = extractEmailFromSpeech(text);
    if (corrected && isValidCustomerEmail(corrected)) {
      ctx.latestRawEmail = text;
      ctx.normalizedEmail = corrected;
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
  const spelled = pending ? spellEmailLetterByLetterForTTS(pending) : "(none yet)";
  const workflow =
    ctx.workflowType === "payment_link" ? "payment_link checkout" : "support_escalation";

  return [
    "EMAIL CONFIRMATION IN PROGRESS (MANDATORY — LLM-DRIVEN)",
    `workflow: ${workflow}`,
    `phase: ${ctx.phase}`,
    `pendingEmail: ${pending || "(awaiting address)"}`,
    `pendingEmailSpelled: ${spelled}`,
    "The caller's raw utterance is authoritative. Honor meta-instructions (e.g. change formatting, fix a letter, start over, 'don't read it like that').",
    "When confirming an email, read it STRICTLY letter-by-letter with short pauses (e.g. B, A, S, H, I at gmail dot com). NEVER use 'A as in Apple' phonetic cue words for email.",
    "If the caller corrects the email, apply CONTEXTUAL REPAIR: call update_pending_email with replace_from/replace_to and/or the full patched address — do NOT re-ask for the entire email. Acknowledge the correction, then read the FULL updated email back once letter-by-letter.",
    "Do NOT say you must finish confirming email before helping — apply their correction or instruction immediately.",
    "Only after they explicitly confirm the spelled email, call send_checkout_email or send_support_escalation as appropriate for this workflow.",
  ].join("\n");
}

export { isEmailPhaseUtterance };
