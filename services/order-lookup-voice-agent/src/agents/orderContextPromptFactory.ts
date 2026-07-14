/**
 * Structured Contextual Injection — typed XML context blocks for the LLM
 * system prompt. Omits empty tags; gates speech when verification is pending.
 */
import type { CallSession } from "../types/order.js";
import type { OrderMetafieldBundle, TimelineAttachment } from "../adapters/orderMetafieldMapping.js";
import type { ParsedCustomerBalance } from "./ledgerNoteParser.js";
import type { OrderView } from "./orderDisclosurePolicy.js";
import type { ActiveOrderContextData } from "./sessionManager.js";
import { getSessionMemory, ensureSessionMemory } from "./sessionMemory.js";

/** Source snapshot for one prompt rebuild. */
export interface OrderContextPromptSource {
  orderMetafields: OrderMetafieldBundle | null;
  timelineAttachments: TimelineAttachment[];
  parsedCustomerBalance: ParsedCustomerBalance | null;
  verificationChallengePending: boolean;
  isVerifiedCaller: boolean;
}

/** Explicit typed contracts for each injectable block (null = omit). */
export interface StructuredContextBlocks {
  accountLedger: string | null;
  subscriptionStatus: string | null;
  verifiedAttachments: string | null;
  verificationChallengeGate: string | null;
}

const CHALLENGE_DIALOG =
  "For your security, I see the order under your name, but I need to verify your details first. Could you please confirm the ZIP code or PO Box on the shipping address?";

function moneyLabel(value: number | undefined | null): string | null {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return `$${Number(value).toFixed(2)}`;
}

function formatAttachmentDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function hasSubscriptionDates(mf: OrderMetafieldBundle | null): boolean {
  if (!mf) return false;
  return Boolean(
    (mf.magazineStartDate && mf.magazineStartDate.trim()) ||
      (mf.endDate && mf.endDate.trim()),
  );
}

function buildAccountLedgerBlock(balance: ParsedCustomerBalance): string {
  const deposit = moneyLabel(balance.deposit);
  const totalOrder = moneyLabel(balance.totalOrder);
  const credit = moneyLabel(balance.creditBalance);
  const lines = [
    "<ACCOUNT_LEDGER>",
    "Parsed account ledger for this order (authoritative for voice):",
  ];
  if (deposit) lines.push(`- Deposit: ${deposit}`);
  if (totalOrder) lines.push(`- Order cost: ${totalOrder}`);
  if (credit) {
    lines.push(`- Remaining credit: ${credit}`);
    lines.push(
      `INSTRUCTION: If the customer asks about modifications, add-ons, or new items, proactively offer this credit once (e.g. "I see you have a remaining credit of ${credit} on your account").`,
    );
  } else {
    lines.push(
      "INSTRUCTION: Mention deposit / order cost only when the caller asks about payment or balance.",
    );
  }
  lines.push("</ACCOUNT_LEDGER>");
  return lines.join("\n");
}

function buildSubscriptionStatusBlock(mf: OrderMetafieldBundle): string {
  const lines = [
    "<SUBSCRIPTION_STATUS>",
    "Subscription / magazine metafields for natural voice phrasing:",
  ];
  if (mf.productName?.trim()) {
    lines.push(`- Product / plan name: ${mf.productName.trim()}`);
  }
  if (mf.magazineStartDate?.trim()) {
    lines.push(`- Magazine start date: ${mf.magazineStartDate.trim()}`);
    lines.push(
      'PHRASING: Say something like "Your magazine subscription started on [date]" — never invent a date.',
    );
  }
  if (mf.endDate?.trim()) {
    lines.push(`- End / renewal date: ${mf.endDate.trim()}`);
    lines.push(
      'PHRASING: Say something like "Your subscription runs through [date]" or "ends on [date]" — never invent a date.',
    );
  }
  lines.push("</SUBSCRIPTION_STATUS>");
  return lines.join("\n");
}

function buildVerifiedAttachmentsBlock(attachments: TimelineAttachment[]): string {
  const lines = [
    "<VERIFIED_ATTACHMENTS>",
    "Files attached on the Shopify order timeline (confirm when the caller asks):",
  ];
  for (const att of attachments) {
    const when = formatAttachmentDate(att.timestamp);
    lines.push(
      when
        ? `- ${att.fileName} (attached on ${when})`
        : `- ${att.fileName}`,
    );
  }
  lines.push(
    'PHRASING EXAMPLE: "Yes, I see the PDF document Christian Sweeten attached to this order on June 29th." Adapt to the actual fileName and date above. Do not invent attachments.',
  );
  lines.push("</VERIFIED_ATTACHMENTS>");
  return lines.join("\n");
}

function buildVerificationChallengeGateBlock(): string {
  return [
    "<VERIFICATION_CHALLENGE_GATE>",
    "SECURITY HOLD ACTIVE: verificationChallengePending is TRUE.",
    "DO NOT speak ACCOUNT_LEDGER balances, SUBSCRIPTION_STATUS dates, VERIFIED_ATTACHMENTS file names, shipping address, past order history, or name line-item titles explicitly until verify_caller_challenge succeeds.",
    `DIALOG PATTERN (use this or a close paraphrase): "${CHALLENGE_DIALOG}"`,
    "Then call verify_caller_challenge with the zip or street / PO Box the caller spoke. Never invent the address. Never read expectedZipCode from any prompt.",
    "</VERIFICATION_CHALLENGE_GATE>",
  ].join("\n");
}

/**
 * Build typed blocks. When challenge is pending, sensitive blocks are omitted
 * entirely (not empty tags) so gated data cannot leak into the prompt.
 */
export function buildStructuredContextBlocks(
  source: OrderContextPromptSource,
): StructuredContextBlocks {
  if (source.verificationChallengePending) {
    return {
      accountLedger: null,
      subscriptionStatus: null,
      verifiedAttachments: null,
      verificationChallengeGate: buildVerificationChallengeGateBlock(),
    };
  }

  const balance = source.parsedCustomerBalance;
  const hasLedger =
    balance != null &&
    (balance.creditBalance != null ||
      balance.deposit != null ||
      balance.totalOrder != null);

  return {
    accountLedger: hasLedger && balance ? buildAccountLedgerBlock(balance) : null,
    subscriptionStatus: hasSubscriptionDates(source.orderMetafields)
      ? buildSubscriptionStatusBlock(source.orderMetafields!)
      : null,
    verifiedAttachments:
      source.timelineAttachments.length > 0
        ? buildVerifiedAttachmentsBlock(source.timelineAttachments)
        : null,
    verificationChallengeGate: null,
  };
}

/** Ordered non-null system message bodies for injection. */
export function assembleStructuredContextSystemMessages(
  blocks: StructuredContextBlocks,
): string[] {
  return [
    blocks.verificationChallengeGate,
    blocks.accountLedger,
    blocks.subscriptionStatus,
    blocks.verifiedAttachments,
  ].filter((s): s is string => typeof s === "string" && s.trim().length > 0);
}

function asMetafieldBundle(raw: unknown): OrderMetafieldBundle | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const productName =
    typeof o.productName === "string"
      ? o.productName
      : typeof o.product_name === "string"
        ? o.product_name
        : null;
  const endDate =
    typeof o.endDate === "string"
      ? o.endDate
      : typeof o.end_date === "string"
        ? o.end_date
        : null;
  const magazineStartDate =
    typeof o.magazineStartDate === "string"
      ? o.magazineStartDate
      : typeof o.magazine_start_date === "string"
        ? o.magazine_start_date
        : null;
  if (!productName && !endDate && !magazineStartDate) return null;
  return { productName, endDate, magazineStartDate };
}

function asAttachments(raw: unknown): TimelineAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: TimelineAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const fileName = String(
      (item as { fileName?: unknown; file_name?: unknown }).fileName ??
        (item as { file_name?: unknown }).file_name ??
        "",
    ).trim();
    if (!fileName) continue;
    const ts =
      (item as { timestamp?: unknown }).timestamp ??
      (item as { createdAt?: unknown }).createdAt ??
      null;
    out.push({
      fileName,
      timestamp: typeof ts === "string" ? ts : null,
    });
  }
  return out;
}

/** Resolve prompt source from live session + sticky order context / OrderView. */
export function resolveOrderContextPromptSource(
  session: CallSession | undefined | null,
  orderContext?: ActiveOrderContextData | OrderView | null,
): OrderContextPromptSource {
  const memory = session
    ? getSessionMemory(session) ?? ensureSessionMemory(session)
    : undefined;
  const ctx = (orderContext ?? {}) as Record<string, unknown>;
  const fromView = asMetafieldBundle(ctx.order_metafields ?? ctx.orderMetafields);
  const attachments = asAttachments(
    ctx.timeline_attachments ?? ctx.timelineAttachments,
  );

  return {
    orderMetafields: fromView,
    timelineAttachments: attachments,
    parsedCustomerBalance: memory?.parsedCustomerBalance ?? null,
    verificationChallengePending: memory?.verificationChallengePending === true,
    isVerifiedCaller: session?.isVerifiedCaller === true,
  };
}

/** Full factory: source → ordered system message strings. */
export function buildOrderContextStructuredSystemMessages(
  session: CallSession | undefined | null,
  orderContext?: ActiveOrderContextData | OrderView | null,
): string[] {
  const source = resolveOrderContextPromptSource(session, orderContext);
  return assembleStructuredContextSystemMessages(buildStructuredContextBlocks(source));
}

export const OrderContextPromptFactory = {
  resolve: resolveOrderContextPromptSource,
  buildBlocks: buildStructuredContextBlocks,
  assemble: assembleStructuredContextSystemMessages,
  buildSystemMessages: buildOrderContextStructuredSystemMessages,
  CHALLENGE_DIALOG,
} as const;
