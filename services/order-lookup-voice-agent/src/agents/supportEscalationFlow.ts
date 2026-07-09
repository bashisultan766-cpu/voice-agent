/**
 * Support escalation state machine — locks intent during escalation.
 * Email capture/confirmation delegates to the central Email Confirmation Engine.
 */
import type { CallSession } from "../types/order.js";
import { logger } from "../utils/logger.js";
import {
  buildEmailCapturePrompt,
  isEmailConfirmationActive,
  registerEmailWorkflowExecutor,
  startEmailCapture,
} from "./emailConfirmationManager.js";
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
  | "support_escalation_submitted";

export interface SupportEscalationContext {
  state: SupportEscalationState;
  requestedInfo: string;
  escalationReason: string;
  issueDescription?: string;
}

const FORWARD_TO_SUPPORT_SPEECH =
  "I understand. Let me forward your details to our support team so they can securely verify you and follow up.";

const SUCCESS_SPEECH =
  "Your request has been forwarded to our support team. Please check your inbox. Our team will contact you soon.";

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
    };
  }
  return session.supportEscalation;
}

export function getSupportEscalationState(session?: CallSession): SupportEscalationState {
  return session?.supportEscalation?.state ?? "normal";
}

/** Maps support + email-confirmation phases for observability and tests. */
export function getSupportEscalationEmailState(session?: CallSession): string {
  const supportState = getSupportEscalationState(session);
  if (supportState === "support_escalation_submitted") return supportState;
  const email = session?.emailConfirmation;
  if (email?.workflowType === "support_escalation") {
    if (email.phase === "collect_email") return "support_escalation_pending_email";
    if (email.phase === "pending_confirmation") return "support_escalation_pending_email_confirmation";
    if (email.phase === "completed") return "support_escalation_submitted";
  }
  return supportState;
}

export function isSupportEscalationActive(session?: CallSession): boolean {
  const state = getSupportEscalationState(session);
  if (state === "non_verified_private_info_blocked") return true;
  if (isEmailConfirmationActive(session) && session?.emailConfirmation?.workflowType === "support_escalation") {
    return true;
  }
  return false;
}

export function isSupportEscalationLocked(session?: CallSession): boolean {
  return (
    isEmailConfirmationActive(session) &&
    session?.emailConfirmation?.workflowType === "support_escalation"
  );
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
  ctx.issueDescription = buildIssueDescription(session, requestedInfo, escalationReason);
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

function buildIssueDescription(
  session: CallSession,
  requestedInfo: string,
  escalationReason: string,
): string {
  const name = String(
    session.currentOrderData?.customer_name ?? session.currentOrder?.customerName ?? "Customer",
  ).trim();
  const orderNum = String(session.currentOrderData?.order_number ?? "").replace(/^#/, "").trim();
  const verified = session.isVerifiedCaller === true ? "verified" : "non-verified";
  const phone = session.callerPhone ?? session.from ?? "unknown number";
  const orderPart = orderNum ? ` for order #${orderNum}` : "";
  return (
    `Customer ${name} called from a ${verified} phone number requesting ${requestedInfo}${orderPart}. ` +
    `${escalationReason} Caller phone: ${phone}.`
  );
}

function buildEscalationDetails(session: CallSession, callbackEmail: string): SupportEscalationDetails {
  const ctx = ensureEscalation(session);
  const orderData = session.currentOrderData ?? {};
  return {
    customerName: String(orderData.customer_name ?? session.currentOrder?.customerName ?? "").trim(),
    callbackEmail,
    callerPhone: session.callerPhone ?? session.from,
    isVerifiedCaller: session.isVerifiedCaller === true,
    orderNumber: String(orderData.order_number ?? "").replace(/^#/, "").trim() || undefined,
    orderEmail: String(orderData.customer_email ?? orderData.order_confirmation_email ?? "").trim() || undefined,
    requestedInfo: ctx.requestedInfo,
    escalationReason: ctx.escalationReason,
    issueDescription:
      ctx.issueDescription ??
      buildIssueDescription(session, ctx.requestedInfo, ctx.escalationReason),
    recommendedAction:
      "Please verify the customer and follow up using the confirmed email.",
  };
}

async function executeSupportEmail(
  session: CallSession,
  confirmedEmail: string,
): Promise<{ ok: boolean; successSpeech: string; failureSpeech: string }> {
  const ctx = ensureEscalation(session);
  if (!isValidCustomerEmail(confirmedEmail)) {
    return {
      ok: false,
      successSpeech: "",
      failureSpeech:
        "I did not catch a complete email address. Please say your full email again slowly, including at and dot com.",
    };
  }
  if (!isResendAvailable()) {
    return {
      ok: false,
      successSpeech: "",
      failureSpeech:
        "I am sorry, but I cannot send the support request email right now. Please call back shortly or email our support team directly.",
    };
  }

  const details = buildEscalationDetails(session, confirmedEmail);
  const result = await sendSupportEscalationDetailed(details);
  if (!result.ok) {
    return {
      ok: false,
      successSpeech: "",
      failureSpeech: "I had trouble sending your request to support. Please say your email again and I will retry.",
    };
  }

  ctx.state = "support_escalation_submitted";
  logger.info("support_email_sent", {
    callSid: session.callSid.slice(0, 8),
    requestedInfo: ctx.requestedInfo,
  });
  logger.info("support_escalation_submitted", {
    callSid: session.callSid.slice(0, 8),
  });
  return { ok: true, successSpeech: SUCCESS_SPEECH, failureSpeech: "" };
}

let executorsRegistered = false;

export function ensureSupportExecutors(): void {
  if (executorsRegistered) return;
  registerEmailWorkflowExecutor("support_escalation", executeSupportEmail);
  executorsRegistered = true;
}

function ensureSupportExecutorsInternal(): void {
  ensureSupportExecutors();
}

function beginSupportEmailCapture(session: CallSession): string {
  ensureSupportExecutorsInternal();
  startEmailCapture(session, "support_escalation");
  logger.info("support_escalation_pending_email", {
    callSid: session.callSid.slice(0, 8),
    requestedInfo: session.supportEscalation?.requestedInfo,
  });
  return `${FORWARD_TO_SUPPORT_SPEECH} ${buildEmailCapturePrompt("support_escalation")}`;
}

/**
 * Deterministic support-escalation turn handler — runs before normal intent routing.
 */
export async function resolveSupportEscalationTurn(
  session: CallSession,
  callerText: string,
): Promise<{ handled: true; speech: string } | { handled: false }> {
  ensureSupportExecutorsInternal();

  const text = (callerText ?? "").trim();
  if (!text) return { handled: false };

  const ctx = ensureEscalation(session);

  if (ctx.state === "support_escalation_submitted") {
    return { handled: false };
  }

  if (isSupportEscalationLocked(session) && /\b(tracking|order number|order history|buy|book|isbn)\b/i.test(text)) {
    return { handled: true, speech: FINISH_SUPPORT_FIRST_SPEECH };
  }

  if (isEmailConfirmationActive(session) && session.emailConfirmation?.workflowType === "support_escalation") {
    return { handled: false };
  }

  if (ctx.state === "non_verified_private_info_blocked") {
    if (isSupportEscalationAcceptance(text, session) || isSupportEscalationRequest(text)) {
      return { handled: true, speech: beginSupportEmailCapture(session) };
    }
    return { handled: false };
  }

  if (isIdentityClaimEscalation(text) && session.isVerifiedCaller !== true) {
    ctx.requestedInfo = "identity verification from alternate phone";
    ctx.escalationReason = "Caller states they are calling from another phone.";
    ctx.issueDescription = buildIssueDescription(session, ctx.requestedInfo, ctx.escalationReason);
    return { handled: true, speech: beginSupportEmailCapture(session) };
  }

  if (isSupportEscalationRequest(text) || (ctx.state === "normal" && isSupportEscalationAcceptance(text, session))) {
    if (ctx.state === "normal") {
      ctx.requestedInfo = "general support request";
      ctx.escalationReason = "Caller requested human support.";
      ctx.issueDescription = buildIssueDescription(session, ctx.requestedInfo, ctx.escalationReason);
    }
    return { handled: true, speech: beginSupportEmailCapture(session) };
  }

  return { handled: false };
}
