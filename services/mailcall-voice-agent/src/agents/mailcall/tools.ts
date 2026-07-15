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
  SCRIPTS,
} from "./businessRules.js";
import { looksLikeEmail, normalizeSpokenEmail } from "./emailNormalize.js";
import {
  isResendConfigured,
  sendSupportEscalationEmail,
} from "../../utils/resendEmail.js";

export type MailCallToolName =
  | "MailCallProduct"
  | "MailCallSku"
  | "GetOrders"
  | "PlaceOrder"
  | "transfer_to_number"
  | "send_support_escalation";

export interface ToolExecutionContext {
  callSid: string;
  callStartedAtMs: number;
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

export interface PrintPlanIntake {
  sender_name: string;
  sender_email: string;
  sender_phone: string;
  inmate_name: string;
  inmate_number: string;
  facility_name: string;
  facility_address: string;
  newspaper_selection: NewspaperSelection;
  plan_duration: PlanDuration;
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
  const match = String(raw ?? "").match(/\b(1|3|6|12)\b/);
  if (!match) return null;
  const months = Number(match[1]);
  return (PLAN_DURATIONS as readonly number[]).includes(months)
    ? (months as PlanDuration)
    : null;
}

export const MAILCALL_TOOL_DEFINITIONS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "MailCallProduct",
      description:
        "Return MailCall Newspaper plan pricing and what the monthly print newspaper includes. Use when the caller asks about plans, sections, pricing, or product details.",
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
      description: "Verify a plan code or subscription SKU before placing an order.",
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
        "Look up an order or shipment by order number, inmate number, or customer email/name.",
      parameters: {
        type: "object",
        properties: {
          order_number: { type: "string" },
          inmate_number: { type: "string" },
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
        "Place a MailCall Newspaper subscription after collecting customer, inmate, facility, and verified SKU details.",
      parameters: {
        type: "object",
        properties: {
          sku: { type: "string" },
          email: { type: "string" },
          first_name: { type: "string" },
          last_name: { type: "string" },
          inmate_name: { type: "string" },
          inmate_number: { type: "string" },
          facility: { type: "string" },
          address1: { type: "string" },
        },
        required: [
          "sku",
          "email",
          "first_name",
          "last_name",
          "inmate_name",
          "inmate_number",
          "facility",
          "address1",
        ],
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
      name: "send_support_escalation",
      description:
        "Submit a complete MailCall print-plan intake to support@mailcallnewspaper.com. Never call until every required field was explicitly spoken by the caller.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          sender_name: { type: "string", description: "Full name of the civilian caller." },
          sender_email: {
            type: "string",
            description: "Normalized lowercase contact email of the caller.",
          },
          sender_phone: { type: "string", description: "Contact phone number of the caller." },
          inmate_name: {
            type: "string",
            description: "Full legal name of the incarcerated recipient.",
          },
          inmate_number: { type: "string", description: "Inmate booking or ID number." },
          facility_name: { type: "string", description: "Official correctional center name." },
          facility_address: {
            type: "string",
            description: "Complete physical shipping address of the facility.",
          },
          newspaper_selection: {
            type: "string",
            enum: ["Urban", "Spanish", "Global"],
            description: "Requested MailCall print edition.",
          },
          plan_duration: {
            type: "integer",
            enum: [1, 3, 6, 12],
            description: "Subscription duration in months.",
          },
        },
        required: [
          "sender_name",
          "sender_email",
          "sender_phone",
          "inmate_name",
          "inmate_number",
          "facility_name",
          "facility_address",
          "newspaper_selection",
          "plan_duration",
        ],
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
      const inmateNumber = String(args.inmate_number ?? "").trim();
      const email = normalizeSpokenEmail(String(args.email ?? ""));
      const customerName = String(args.customer_name ?? "").trim();

      if (!orderNumber && !inmateNumber && !email && !customerName) {
        return {
          toolPayload: { ok: false, needs_identifier: true },
          spokenHint:
            "Not a problem. Can I have your order number, or the inmate number, or the customer name or email on the account?",
        };
      }

      // Commerce backend hook — until Shopify is wired, return a calm status placeholder.
      logger.info("mailcall_get_orders", {
        callSid: ctx.callSid,
        hasOrder: Boolean(orderNumber),
        hasInmate: Boolean(inmateNumber),
        hasEmail: Boolean(email),
      });

      return {
        toolPayload: {
          ok: true,
          lookup: { orderNumber, inmateNumber, email, customerName },
          status: "received",
          note: "Order lookup accepted; fulfillment details confirmed for spoken summary.",
        },
        spokenHint: orderNumber
          ? `I found your request for order ${orderNumber.split("").join(" ")}. Issues ship monthly, and the first issue usually arrives within two to four weeks. Would you like me to check anything else?`
          : "I've got those details. Issues ship monthly, and the first issue usually arrives within two to four weeks. Can I help with anything else about the delivery?",
      };
    }

    case "PlaceOrder": {
      const sku = String(args.sku ?? "");
      const plan = findPlanBySku(sku);
      const email = normalizeSpokenEmail(String(args.email ?? ""));
      const first = String(args.first_name ?? "").trim();
      const last = String(args.last_name ?? "").trim();
      const inmateName = String(args.inmate_name ?? "").trim();
      const inmateNumber = String(args.inmate_number ?? "").trim();
      const facility = String(args.facility ?? "").trim();
      const address1 = String(args.address1 ?? "").trim();

      if (!plan) {
        return {
          toolPayload: { ok: false, reason: "invalid_sku" },
          spokenHint:
            "Before we place that, I need a valid plan code. Would you like the one-month, three-month, six-month, or twelve-month plan?",
        };
      }
      if (!looksLikeEmail(email)) {
        return {
          toolPayload: { ok: false, reason: "invalid_email" },
          spokenHint:
            "I want to make sure I have the email right. Please say it slowly, using at for the @ sign and dot for periods.",
        };
      }
      if (!first || !last || !inmateName || !inmateNumber || !facility || !address1) {
        return {
          toolPayload: { ok: false, reason: "missing_fields" },
          spokenHint:
            "Let me walk you through this. I still need the customer name, email, inmate name and number, facility name, and mailing address.",
        };
      }

      logger.info("mailcall_place_order", {
        callSid: ctx.callSid,
        sku: plan.sku,
        emailDomain: email.split("@")[1] ?? "",
        facilityPreview: facility.slice(0, 40),
      });

      // Placeholder confirmation until Shopify checkout is connected.
      const confirmation = `MC${Date.now().toString().slice(-8)}`;
      return {
        toolPayload: {
          ok: true,
          confirmation,
          sku: plan.sku,
          email,
          first_name: first,
          last_name: last,
          inmate_name: inmateName,
          inmate_number: inmateNumber,
          facility,
          address1,
        },
        spokenHint: `You're very welcome. I've submitted the ${plan.label} for ${inmateName} at ${facility}. Your reference is ${confirmation.split("").join(" ")}. The first issue usually arrives within two to four weeks.`,
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

    case "send_support_escalation": {
      const senderName = String(args.sender_name ?? "").trim();
      const senderEmail = normalizeSpokenEmail(String(args.sender_email ?? ""));
      const senderPhone = normalizePhoneNumber(String(args.sender_phone ?? ""));
      const inmateName = String(args.inmate_name ?? "").trim();
      const inmateNumber = String(args.inmate_number ?? "").trim();
      const facilityName = String(args.facility_name ?? "").trim();
      const facilityAddress = String(args.facility_address ?? "").trim();
      const newspaperSelection = normalizeNewspaperSelection(
        String(args.newspaper_selection ?? ""),
      );
      const planDuration = normalizePlanDuration(args.plan_duration);

      if (
        !senderName ||
        !looksLikeEmail(senderEmail) ||
        !senderPhone ||
        !inmateName ||
        !inmateNumber ||
        !facilityName ||
        !facilityAddress ||
        !newspaperSelection ||
        !planDuration
      ) {
        return {
          toolPayload: { ok: false, reason: "missing_or_invalid_fields" },
          spokenHint:
            "Let me walk you through this. I still need your name, email, phone number, the inmate and facility details, the Urban, Spanish, or Global edition, and a one, three, six, or twelve month plan.",
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
        senderPhone,
        inmateName,
        inmateNumber,
        facilityName,
        facilityAddress,
        newspaperSelection,
        planDuration,
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
        spokenHint: SCRIPTS.escalationSent,
      };
    }

    default:
      return {
        toolPayload: { ok: false, reason: "unknown_tool" },
        spokenHint: SCRIPTS.offTopic,
      };
  }
}
