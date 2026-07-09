/**
 * Central Email Confirmation Engine — single state machine for all email workflows.
 * Used by support escalation and payment-link checkout (separate business flows).
 */
import type { CallSession } from "../types/order.js";
import { logger } from "../utils/logger.js";
import {
  buildEmailConfirmationSpeech,
  extractEmailFromSpeech,
  isEmailConfirmation,
  isEmailRejection,
  looksLikePartialEmail,
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

const FINISH_EMAIL_FIRST_SPEECH =
  "I need to finish confirming your email first. After that, I can help with your other question.";

const FINISH_SUPPORT_FIRST_SPEECH =
  "I'll finish your support request first. After that, I can help with tracking or other order questions.";

function blockInterruptionDuringEmailCapture(session: CallSession, text: string): string | null {
  if (!isEmailConfirmationActive(session)) return null;
  if (!/\b(tracking|order number|order history|buy|book|isbn|checkout|cart)\b/i.test(text)) {
    return null;
  }
  if (session.emailConfirmation?.workflowType === "support_escalation") {
    return FINISH_SUPPORT_FIRST_SPEECH;
  }
  return FINISH_EMAIL_FIRST_SPEECH;
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
  return session.emailConfirmation.phase === "completed"
    ? session.emailConfirmation.workflowType
    : session.emailConfirmation.workflowType;
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

export function buildEmailCapturePrompt(workflowType: EmailWorkflowType): string {
  if (workflowType === "payment_link") {
    return `To send your secure payment link, ${ASK_EMAIL_SPEECH}`;
  }
  return ASK_EMAIL_SPEECH;
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
  if (looksLikePartialEmail(text)) {
    return { handled: true, speech: ASK_EMAIL_AGAIN_SPEECH };
  }
  return { handled: true, speech: ASK_EMAIL_AGAIN_SPEECH };
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
 * Deterministic email-confirmation turn — highest routing priority.
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

  const interruption = blockInterruptionDuringEmailCapture(session, text);
  if (interruption) {
    return { handled: true, speech: interruption };
  }

  if (ctx.phase === "collect_email") {
    return captureEmailFromSpeech(session, text);
  }

  if (ctx.phase === "pending_confirmation") {
    if (isEmailRejection(text)) {
      ctx.phase = "collect_email";
      ctx.normalizedEmail = undefined;
      ctx.latestRawEmail = undefined;
      ctx.confirmationStatus = "rejected";
      return { handled: true, speech: buildEmailCapturePrompt(ctx.workflowType) };
    }

    if (isEmailConfirmation(text)) {
      return confirmAndSend(session);
    }

    const corrected = extractEmailFromSpeech(text);
    if (corrected && isValidCustomerEmail(corrected)) {
      ctx.latestRawEmail = text;
      ctx.normalizedEmail = corrected;
      return { handled: true, speech: buildEmailConfirmationSpeech(corrected) };
    }

    return {
      handled: true,
      speech: "Please say yes if the email is correct, or no and repeat your email address.",
    };
  }

  return { handled: false };
}

/** Block lower-priority workflows while email confirmation is active. */
export function blockDuringEmailConfirmation(
  session: CallSession,
  callerText: string,
): string | null {
  if (!isEmailConfirmationLocked(session)) return null;
  if (/\b(tracking|order number|order history|buy|book|isbn|checkout|cart)\b/i.test(callerText)) {
    return FINISH_EMAIL_FIRST_SPEECH;
  }
  return null;
}
