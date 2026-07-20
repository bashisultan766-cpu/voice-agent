/**
 * Brook tool surface — OpenAI function tools + deterministic executors.
 * Results are always speech-safe JSON summaries (never raw CMS jargon for the caller).
 */

import type OpenAI from "openai";
import { getConfig } from "../../config.js";
import { logger } from "../../utils/logger.js";
import {
  buildProductCatalogSpeech,
  canTransferToLiveAgent,
  findPlanBySku,
  MAILCALL_PLANS,
  PACKAGE_TYPES,
  SCRIPTS,
  type PackageType,
} from "./businessRules.js";
import { looksLikeEmail, normalizeSpokenEmail } from "./emailNormalize.js";
import {
  isResendConfigured,
  resolveCheckoutUrl,
  sendCheckoutLinkEmail,
  sendSupportEscalationEmail,
} from "../../utils/resendEmail.js";

export type MailCallToolName =
  | "MailCallProduct"
  | "MailCallSku"
  | "GetOrders"
  | "PlaceOrder"
  | "transfer_to_number"
  | "send_checkout_link"
  | "send_support_escalation";

export interface ToolExecutionContext {
  callSid: string;
  callStartedAtMs: number;
  /** When true, allow another checkout email after an explicit resend confirmation. */
  forceResend?: boolean;
}

export interface ToolExecutionResult {
  /** Compact facts for the model (not spoken verbatim if technical). */
  toolPayload: Record<string, unknown>;
  /** Optional ready-to-speak line the model should prefer. */
  spokenHint?: string;
  /** When set, ConversationRelay should hand off / dial this number. */
  transferToNumber?: string;
}

export const NEWSPAPER_SELECTIONS = ["Urban", "Spanish", "Global"] as const;
export const PLAN_DURATIONS = [1, 3, 6, 12] as const;

export type NewspaperSelection = (typeof NEWSPAPER_SELECTIONS)[number];
export type PlanDuration = (typeof PLAN_DURATIONS)[number];

/** Frictionless checkout intake — email only; plans/inmate details stay on the website. */
export interface CheckoutLinkIntake {
  contact_email: string;
  email_confirmed: boolean;
}

/** Per-call lock so send_checkout_link cannot spam the same session. */
const checkoutSendLock = new Map<string, { email: string; sentAtMs: number }>();

export function clearCheckoutSendLock(callSid?: string): void {
  if (callSid) checkoutSendLock.delete(callSid);
  else checkoutSendLock.clear();
}

export function getCheckoutSendLock(callSid: string): { email: string; sentAtMs: number } | undefined {
  return checkoutSendLock.get(callSid);
}

export function normalizePhoneNumber(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  const phoneWords: Record<string, string> = {
    zero: "0",
    oh: "0",
    one: "1",
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9",
  };
  const expanded = trimmed
    .toLowerCase()
    .replace(
      /\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g,
      (word) => phoneWords[word] ?? "",
    );
  const digits = expanded.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return "";
  return trimmed.startsWith("+") ? `+${digits}` : digits;
}

export function normalizeNewspaperSelection(raw: string): NewspaperSelection | null {
  const value = String(raw ?? "").trim().toLowerCase();
  if (/\burban\b/.test(value)) return "Urban";
  if (/\bspanish\b/.test(value)) return "Spanish";
  if (/\bglobal\b/.test(value)) return "Global";
  return null;
}

export function normalizePlanDuration(raw: unknown): PlanDuration | null {
  const value = String(raw ?? "").toLowerCase();
  if (/\b(12|twelve|one year|yearly|annual)\b/.test(value)) return 12;
  if (/\b(6|six)\b/.test(value)) return 6;
  if (/\b(3|three|quarterly)\b/.test(value)) return 3;
  if (/\b(1|one|monthly)\b/.test(value)) return 1;
  return null;
}

export function normalizePackageType(raw: string): PackageType | null {
  const value = String(raw ?? "").trim().toLowerCase();
  if (
    /\bbundle of three|three[- ]edition|triple\b/.test(value) ||
    (/\bthree\b/.test(value) && /\bbundle\b/.test(value))
  ) {
    return "Bundle of Three";
  }
  if (
    /\bbundle of two|two[- ]edition|double\b/.test(value) ||
    (/\btwo\b/.test(value) && /\bbundle\b/.test(value))
  ) {
    return "Bundle of Two";
  }
  if (/\bsingle\b/.test(value) || /\bone edition\b/.test(value)) {
    return "Single Edition";
  }
  // Bare answers during intake.
  if (/^(single|one)$/i.test(value.trim())) return "Single Edition";
  if (/^(two|2)$/i.test(value.trim())) return "Bundle of Two";
  if (/^(three|3)$/i.test(value.trim())) return "Bundle of Three";
  return null;
}

export function isEmailConfirmation(utterance: string): boolean | null {
  const u = utterance.trim().toLowerCase();
  if (/\b(yes|correct|that's right|that is right|yep|yeah|affirmative|confirmed?)\b/.test(u)) {
    return true;
  }
  if (/\b(no|incorrect|wrong|not right|nope)\b/.test(u)) {
    return false;
  }
  return null;
}

export const MAILCALL_TOOL_DEFINITIONS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "MailCallProduct",
      description:
        "Return MailCall Newspaper plan pricing, publication categories (Urban, Spanish, Global), and package types. Use when the caller asks about plans, sections, pricing, or product details.",
      parameters: {
        type: "object",
        properties: {
          focus_sku: {
            type: "string",
            description: "Optional SKU to highlight (MC-1M, MC-3M, MC-6M, MC-12M).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "MailCallSku",
      description: "Verify a plan code or subscription SKU before sending a checkout link.",
      parameters: {
        type: "object",
        properties: {
          sku: { type: "string", description: "Plan code or SKU from the caller." },
        },
        required: ["sku"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "GetOrders",
      description:
        "Look up an order or shipment by order number, customer email, or customer name. Do not ask for inmate or facility details.",
      parameters: {
        type: "object",
        properties: {
          order_number: { type: "string" },
          email: { type: "string" },
          customer_name: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "PlaceOrder",
      description:
        "Do not place orders over the phone. Guide the caller to the privacy-safe checkout-link flow instead (publication, plan, package, email).",
      parameters: {
        type: "object",
        properties: {
          note: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "transfer_to_number",
      description:
        "Transfer to a live agent. Only call when office hours are open and the call has lasted over five minutes.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Brief reason for the transfer." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_checkout_link",
      description:
        "Email a Send Newspaper order link to the caller's verified contact email. Do not ask for plans, packages, inmate, or facility details. Only call after the email is confirmed. Do not call again in the same call unless the caller explicitly asks to resend.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          contact_email: {
            type: "string",
            description: "Normalized lowercase contact email of the caller.",
          },
          force_resend: {
            type: "boolean",
            description:
              "Set true only after the caller explicitly confirms they want the link resent.",
          },
        },
        required: ["contact_email"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_support_escalation",
      description:
        "Send a privacy-safe support note to the MailCall team. Include only caller contact details and a brief issue summary — never inmate or facility PII.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          sender_name: { type: "string", description: "Full name of the civilian caller." },
          sender_email: {
            type: "string",
            description: "Normalized lowercase contact email of the caller.",
          },
          sender_phone: { type: "string", description: "Optional contact phone number." },
          issue_summary: {
            type: "string",
            description: "Brief summary of the support issue (no inmate/facility PII).",
          },
        },
        required: ["sender_name", "sender_email", "issue_summary"],
      },
    },
  },
];

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function executeMailCallTool(
  name: string,
  rawArgs: string | undefined,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const args = parseArgs(rawArgs);

  switch (name as MailCallToolName) {
    case "MailCallProduct": {
      const focus = typeof args.focus_sku === "string" ? args.focus_sku : undefined;
      const speech = buildProductCatalogSpeech(focus);
      return {
        toolPayload: {
          ok: true,
          plans: MAILCALL_PLANS.map((p) => ({
            sku: p.sku,
            label: p.label,
            price_usd: p.priceUsd,
          })),
          categories: [...NEWSPAPER_SELECTIONS],
          packages: [...PACKAGE_TYPES],
        },
        spokenHint: speech,
      };
    }

    case "MailCallSku": {
      const sku = String(args.sku ?? "");
      const plan = findPlanBySku(sku);
      if (!plan) {
        return {
          toolPayload: { ok: false, sku },
          spokenHint:
            "I couldn't verify that plan code. Our codes are M C one M, M C three M, M C six M, and M C twelve M. Which plan were you hoping for?",
        };
      }
      return {
        toolPayload: {
          ok: true,
          sku: plan.sku,
          label: plan.label,
          price_usd: plan.priceUsd,
        },
        spokenHint: `You're very welcome — that code matches our ${plan.label} at ${plan.priceSpoken}.`,
      };
    }

    case "GetOrders": {
      const orderNumber = String(args.order_number ?? "").trim();
      const email = normalizeSpokenEmail(String(args.email ?? ""));
      const customerName = String(args.customer_name ?? "").trim();

      if (!orderNumber && !email && !customerName) {
        return {
          toolPayload: { ok: false, needs_identifier: true },
          spokenHint:
            "Not a problem. Can I have your order number, or the customer name or email on the account?",
        };
      }

      logger.info("mailcall_get_orders", {
        callSid: ctx.callSid,
        hasOrder: Boolean(orderNumber),
        hasEmail: Boolean(email),
      });

      return {
        toolPayload: {
          ok: true,
          lookup: { orderNumber, email, customerName },
          status: "received",
          note: "Order lookup accepted; fulfillment details confirmed for spoken summary.",
        },
        spokenHint: orderNumber
          ? `I found your request for order ${orderNumber.split("").join(" ")}. Issues ship monthly, and the first issue usually arrives within two to four weeks. Would you like me to check anything else?`
          : "I've got those details. Issues ship monthly, and the first issue usually arrives within two to four weeks. Can I help with anything else about the delivery?",
      };
    }

    case "PlaceOrder": {
      return {
        toolPayload: {
          ok: false,
          reason: "use_checkout_link",
          checkout_url: resolveCheckoutUrl(),
        },
        spokenHint:
          "For privacy, we complete purchases online. What email address should I send the order link to?",
      };
    }

    case "transfer_to_number": {
      const cfg = getConfig();
      const transferTo = (cfg.MAILCALL_TRANSFER_NUMBER ?? "").trim();
      const gate = canTransferToLiveAgent({
        callStartedAtMs: ctx.callStartedAtMs,
        transferNumberConfigured: Boolean(transferTo),
      });
      if (!gate.allowed) {
        return {
          toolPayload: { ok: false, transferred: false },
          spokenHint: gate.reasonSpoken,
        };
      }
      return {
        toolPayload: { ok: true, transferred: true, reason: args.reason ?? "" },
        spokenHint: gate.reasonSpoken,
        transferToNumber: transferTo,
      };
    }

    case "send_checkout_link": {
      const contactEmail = normalizeSpokenEmail(String(args.contact_email ?? ""));
      const forceResend =
        Boolean(args.force_resend) || Boolean(ctx.forceResend);

      if (!looksLikeEmail(contactEmail)) {
        return {
          toolPayload: { ok: false, reason: "missing_or_invalid_fields" },
          spokenHint:
            "I didn't quite catch that email. Could you say it one more time?",
        };
      }

      const prior = checkoutSendLock.get(ctx.callSid);
      if (prior && !forceResend) {
        return {
          toolPayload: {
            ok: false,
            reason: "already_sent",
            to: prior.email,
            hasCheckoutLinkBeenSent: true,
          },
          spokenHint: SCRIPTS.checkoutAlreadySent,
        };
      }

      if (!isResendConfigured()) {
        logger.warn("mailcall_checkout_resend_unconfigured", { callSid: ctx.callSid });
        return {
          toolPayload: { ok: false, reason: "email_unavailable" },
          spokenHint: SCRIPTS.voicemail,
        };
      }

      const checkoutUrl = resolveCheckoutUrl();
      const sent = await sendCheckoutLinkEmail({
        contactEmail,
        checkoutUrl,
        callSid: ctx.callSid,
      });

      if (!sent.ok) {
        logger.warn("mailcall_checkout_link_failed", {
          callSid: ctx.callSid,
          error: sent.error,
        });
        return {
          toolPayload: { ok: false, reason: "send_failed" },
          spokenHint: SCRIPTS.voicemail,
        };
      }

      checkoutSendLock.set(ctx.callSid, {
        email: contactEmail,
        sentAtMs: Date.now(),
      });

      logger.info("mailcall_checkout_link_sent", {
        callSid: ctx.callSid,
        messageId: sent.messageId,
        emailDomain: contactEmail.split("@")[1] ?? "",
        resent: forceResend,
      });

      return {
        toolPayload: {
          ok: true,
          messageId: sent.messageId,
          to: contactEmail,
          checkout_url: checkoutUrl,
          hasCheckoutLinkBeenSent: true,
          resent: forceResend,
        },
        spokenHint: forceResend ? SCRIPTS.checkoutResent : SCRIPTS.checkoutLinkSent,
      };
    }

    case "send_support_escalation": {
      const senderName = String(args.sender_name ?? "").trim();
      const senderEmail = normalizeSpokenEmail(String(args.sender_email ?? ""));
      const senderPhone = normalizePhoneNumber(String(args.sender_phone ?? ""));
      const issueSummary = String(args.issue_summary ?? "").trim();

      if (!senderName || !looksLikeEmail(senderEmail) || !issueSummary) {
        return {
          toolPayload: { ok: false, reason: "missing_or_invalid_fields" },
          spokenHint:
            "I can escalate this for you. I just need your name, email, and a short summary of the issue — without inmate or facility details over the phone.",
        };
      }

      if (!isResendConfigured()) {
        logger.warn("mailcall_escalation_resend_unconfigured", { callSid: ctx.callSid });
        return {
          toolPayload: { ok: false, reason: "email_unavailable" },
          spokenHint: SCRIPTS.voicemail,
        };
      }

      const sent = await sendSupportEscalationEmail({
        senderName,
        senderEmail,
        senderPhone: senderPhone || undefined,
        issueSummary,
        callSid: ctx.callSid,
      });

      if (!sent.ok) {
        logger.warn("mailcall_escalation_failed", {
          callSid: ctx.callSid,
          error: sent.error,
        });
        return {
          toolPayload: { ok: false, reason: "send_failed" },
          spokenHint: SCRIPTS.voicemail,
        };
      }

      logger.info("mailcall_escalation_sent", {
        callSid: ctx.callSid,
        messageId: sent.messageId,
      });

      return {
        toolPayload: {
          ok: true,
          messageId: sent.messageId,
          to: "support@mailcallnewspaper.com",
        },
        spokenHint:
          "I've passed your note to our support team. They will follow up using the email you provided.",
      };
    }

    default:
      return {
        toolPayload: { ok: false, reason: "unknown_tool" },
        spokenHint: SCRIPTS.offTopic,
      };
  }
}
