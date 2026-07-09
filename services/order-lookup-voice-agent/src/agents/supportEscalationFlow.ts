/**
 * Support escalation state machine — locks intent during email capture/confirmation.
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
import {
  isResendAvailable,
  isValidCustomerEmail,
  sendSupportEscalationDetailed,
  type SupportEscalationDetails,
} from "../utils/resendEmailService.js";
import { isConfirmKeyword } from "./conversationFlowState.js";
import { isSupportEscalationRequest } from "./callerIntent.js";

export type SupportEscalationState =
  | "normal"
  | "non_verified_private_info_blocked"
  | "support_escalation_pending_email"
  | "support_escalation_pending_email_confirmation"
  | "support_escalation_submitted";

export interface SupportEscalationContext {
  state: SupportEscalationState;
  requestedInfo: string;
  escalationReason: string;
  pendingEmail?: string;
  transcriptSnippets: string[];
}

const ASK_EMAIL_SPEECH =
  "What email address should our support team use to contact you? Please say it clearly, for example, your name at gmail dot com.";

const ASK_EMAIL_AGAIN_SPEECH =
  "I did not catch a complete email address. Please say your full email again slowly, including at and dot com.";

const FORWARD_TO_SUPPORT_SPEECH =
  "I understand. Let me forward your details to our support team so they can securely verify you and follow up.";

const SUCCESS_SPEECH =
  "Thank you. I've forwarded your request to our support team. They will review the verification issue and follow up with you.";

const FINISH_SUPPORT_FIRST_SPEECH =
  "I'll finish your support request first. After that, I can help with tracking or other order questions.";

const SUPPORT_OFFER_SUFFIX =
  " Would you like me to forward your request to our support team so they can verify you and follow up?";

function ensureEscalation(session: CallSession): SupportEscalationContext {
  if (!session.supportEscalation) {
    session.supportEscalation = {
      state: "normal",
      requestedInfo: "protected information",
      escalationReason: "Caller needs human support follow-up.",
      transcriptSnippets: [],
    };
  }
  return session.supportEscalation;
}

export function getSupportEscalationState(session?: CallSession): SupportEscalationState {
  return session?.supportEscalation?.state ?? "normal";
}

export function isSupportEscalationActive(session?: CallSession): boolean {
  const state = getSupportEscalationState(session);
  return (
    state === "non_verified_private_info_blocked" ||
    state === "support_escalation_pending_email" ||
    state === "support_escalation_pending_email_confirmation"
  );
}

export function isSupportEscalationLocked(session?: CallSession): boolean {
  const state = getSupportEscalationState(session);
  return (
    state === "support_escalation_pending_email" ||
    state === "support_escalation_pending_email_confirmation"
  );
}

export function appendEscalationTranscript(session: CallSession, role: "caller" | "agent", text: string): void {
  const ctx = ensureEscalation(session);
  const line = `${role}: ${text.trim().slice(0, 240)}`;
  ctx.transcriptSnippets.push(line);
  if (ctx.transcriptSnippets.length > 12) {
    ctx.transcriptSnippets = ctx.transcriptSnippets.slice(-12);
  }
}

export function armPrivateInfoBlockedEscalation(
  session: CallSession,
  requestedInfo: string,
  escalationReason: string,
): void {
  const ctx = ensureEscalation(session);
  ctx.state = "non_verified_private_info_blocked";
  ctx.requestedInfo = requestedInfo;
  ctx.escalationReason = escalationReason;
  ctx.pendingEmail = undefined;
}

export function buildUnverifiedRefusalWithSupportOffer(customerName?: string): string {
  const name = String(customerName ?? "the registered customer").trim() || "the registered customer";
  return (
    `I am sorry, but for security reasons, I can only share that information with the verified account holder, ${name}.` +
    SUPPORT_OFFER_SUFFIX
  );
}

export function isSupportEscalationAcceptance(text: string, session?: CallSession): boolean {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return false;
  const state = session?.supportEscalation?.state ?? "normal";

  if (/\b(forward\s+(?:it|this|my\s+request)|yes.{0,40}support|support\s+team|please\s+forward)\b/i.test(trimmed)) {
    return true;
  }
  if (/^\s*please\b/i.test(trimmed) && /\b(forward|support|escalat)\b/i.test(trimmed)) return true;

  if (state !== "non_verified_private_info_blocked") return false;

  if (isConfirmKeyword(trimmed)) return true;
  if (/^\s*(yes|yeah|yep|yup|sure|ok|okay)\b/i.test(trimmed)) return true;
  return false;
}

export function isIdentityClaimEscalation(text: string): boolean {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return false;
  return (
    /\b(calling from (?:a |another |different )?phone|different phone|another phone|phone is dead|can't verify|cannot verify|not on this line)\b/i.test(
      trimmed,
    ) ||
    /\bi am .+ but\b/i.test(trimmed)
  );
}

function beginPendingEmail(session: CallSession): string {
  const ctx = ensureEscalation(session);
  ctx.state = "support_escalation_pending_email";
  ctx.pendingEmail = undefined;
  logger.info("support_escalation_pending_email", {
    callSid: session.callSid.slice(0, 8),
    requestedInfo: ctx.requestedInfo,
  });
  return `${FORWARD_TO_SUPPORT_SPEECH} ${ASK_EMAIL_SPEECH}`;
}

function buildEscalationDetails(session: CallSession): SupportEscalationDetails {
  const ctx = ensureEscalation(session);
  const orderData = session.currentOrderData ?? {};
  const conversationSummary = ctx.transcriptSnippets.join(" | ") || "No transcript captured.";
  return {
    customerName: String(orderData.customer_name ?? session.currentOrder?.customerName ?? "").trim(),
    callbackEmail: ctx.pendingEmail ?? "",
    callerPhone: session.callerPhone ?? session.from,
    isVerifiedCaller: session.isVerifiedCaller === true,
    orderNumber: String(orderData.order_number ?? "").replace(/^#/, "").trim() || undefined,
    orderEmail: String(orderData.customer_email ?? orderData.order_confirmation_email ?? "").trim() || undefined,
    requestedInfo: ctx.requestedInfo,
    escalationReason: ctx.escalationReason,
    conversationSummary,
    recommendedAction:
      "Contact the caller at the callback email, verify identity, then provide the requested protected order information.",
  };
}

async function submitSupportEscalation(session: CallSession): Promise<string> {
  const ctx = ensureEscalation(session);
  if (!ctx.pendingEmail || !isValidCustomerEmail(ctx.pendingEmail)) {
    ctx.state = "support_escalation_pending_email";
    return ASK_EMAIL_AGAIN_SPEECH;
  }
  if (!isResendAvailable()) {
    return "I am sorry, but I cannot send the support request email right now. Please call back shortly or email our support team directly.";
  }

  const details = buildEscalationDetails(session);
  const result = await sendSupportEscalationDetailed(details);
  if (!result.ok) {
    return "I had trouble sending your request to support. Please say your email again and I will retry.";
  }

  ctx.state = "support_escalation_submitted";
  logger.info("support_email_sent", {
    callSid: session.callSid.slice(0, 8),
    requestedInfo: ctx.requestedInfo,
  });
  logger.info("support_escalation_submitted", {
    callSid: session.callSid.slice(0, 8),
  });
  return SUCCESS_SPEECH;
}

/**
 * Deterministic support-escalation turn handler — runs before normal intent routing.
 */
export async function resolveSupportEscalationTurn(
  session: CallSession,
  callerText: string,
): Promise<{ handled: true; speech: string } | { handled: false }> {
  const text = (callerText ?? "").trim();
  if (!text) return { handled: false };

  const ctx = ensureEscalation(session);
  appendEscalationTranscript(session, "caller", text);

  if (ctx.state === "support_escalation_submitted") {
    return { handled: false };
  }

  if (isSupportEscalationLocked(session) && /\b(tracking|order number|order history|buy|book|isbn)\b/i.test(text)) {
    return { handled: true, speech: FINISH_SUPPORT_FIRST_SPEECH };
  }

  if (ctx.state === "non_verified_private_info_blocked") {
    if (isSupportEscalationAcceptance(text, session) || isSupportEscalationRequest(text)) {
      const speech = beginPendingEmail(session);
      appendEscalationTranscript(session, "agent", speech);
      return { handled: true, speech };
    }
    return { handled: false };
  }

  if (isIdentityClaimEscalation(text) && session.isVerifiedCaller !== true) {
    ctx.requestedInfo = "identity verification from alternate phone";
    ctx.escalationReason = "Caller claims identity but is not verified on this line.";
    const speech = beginPendingEmail(session);
    appendEscalationTranscript(session, "agent", speech);
    return { handled: true, speech };
  }

  if (
    (isSupportEscalationRequest(text) || (ctx.state === "normal" && isSupportEscalationAcceptance(text, session))) &&
    ctx.state !== "support_escalation_pending_email" &&
    ctx.state !== "support_escalation_pending_email_confirmation"
  ) {
    if (ctx.state === "normal") {
      ctx.requestedInfo = "general support request";
      ctx.escalationReason = "Caller requested human support.";
    }
    const speech = beginPendingEmail(session);
    appendEscalationTranscript(session, "agent", speech);
    return { handled: true, speech };
  }

  if (ctx.state === "support_escalation_pending_email") {
    const email = extractEmailFromSpeech(text);
    if (email && isValidCustomerEmail(email)) {
      ctx.pendingEmail = email;
      ctx.state = "support_escalation_pending_email_confirmation";
      logger.info("email_extracted", {
        callSid: session.callSid.slice(0, 8),
        emailDomain: email.split("@")[1] ?? "unknown",
      });
      const speech = buildEmailConfirmationSpeech(email);
      logger.info("email_confirmation_requested", {
        callSid: session.callSid.slice(0, 8),
      });
      appendEscalationTranscript(session, "agent", speech);
      return { handled: true, speech };
    }

    if (looksLikePartialEmail(text)) {
      const speech = ASK_EMAIL_AGAIN_SPEECH;
      appendEscalationTranscript(session, "agent", speech);
      return { handled: true, speech };
    }

    const speech = ASK_EMAIL_AGAIN_SPEECH;
    appendEscalationTranscript(session, "agent", speech);
    return { handled: true, speech };
  }

  if (ctx.state === "support_escalation_pending_email_confirmation") {
    if (isEmailRejection(text)) {
      ctx.state = "support_escalation_pending_email";
      ctx.pendingEmail = undefined;
      const speech = ASK_EMAIL_SPEECH;
      appendEscalationTranscript(session, "agent", speech);
      return { handled: true, speech };
    }

    if (isEmailConfirmation(text)) {
      const speech = await submitSupportEscalation(session);
      appendEscalationTranscript(session, "agent", speech);
      return { handled: true, speech };
    }

    const corrected = extractEmailFromSpeech(text);
    if (corrected && isValidCustomerEmail(corrected)) {
      ctx.pendingEmail = corrected;
      const speech = buildEmailConfirmationSpeech(corrected);
      appendEscalationTranscript(session, "agent", speech);
      return { handled: true, speech };
    }

    const speech =
      "Please say yes if the email is correct, or no and repeat your email address.";
    appendEscalationTranscript(session, "agent", speech);
    return { handled: true, speech };
  }

  return { handled: false };
}
