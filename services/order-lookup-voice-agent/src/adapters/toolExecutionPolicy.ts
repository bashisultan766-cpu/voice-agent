/**
 * Tool execution policy — Zod parameter validation + secure session injection.
 * Runs before any Shopify / Resend call so hallucinated LLM args never hit the API.
 */
import { z } from "zod";
import type { CallSession } from "../types/order.js";
import { getUnifiedSession } from "../agents/unifiedCallSession.js";
import { isValidCustomerEmail } from "../utils/resendEmailService.js";
import { isValidOrderNumberFormat } from "../utils/formatter.js";
import { normalizeOrderNumber } from "../utils/inputNormalizer.js";
import { normalizeIsbn, isValidIsbnFormat } from "../utils/productSearchNormalize.js";
import { isValidTrackingNumber } from "./orderFieldExtractors.js";
import type { LlmToolExecutionRecord, LlmToolName } from "./llmToolExecutor.js";

const VALIDATION_PREFIX = "Validation Error: ";

function validationMessage(detail: string): string {
  const trimmed = detail.trim();
  return trimmed.startsWith(VALIDATION_PREFIX) ? trimmed : `${VALIDATION_PREFIX}${trimmed}`;
}

function looksLikeIsbnNotOrder(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  return (
    (digits.length === 10 || digits.length === 13) && isValidIsbnFormat(digits)
  );
}

function looksLikeIsbnAsTracking(raw: string): boolean {
  const compact = raw.replace(/[\s\-_.]/g, "");
  return isValidIsbnFormat(compact);
}

const emptyArgsSchema = z.record(z.unknown()).optional().default({});

const orderStatusSchema = z
  .object({
    orderNumber: z.union([z.string(), z.number()]).transform((v) => String(v).trim()),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    const normalized = normalizeOrderNumber(data.orderNumber);
    if (looksLikeIsbnNotOrder(data.orderNumber) || looksLikeIsbnNotOrder(normalized)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: validationMessage(
          "That looks like an ISBN, not an order number. Use search_shopify_book_by_isbn for catalog lookup.",
        ),
      });
      return;
    }
    if (!normalized || !isValidOrderNumberFormat(normalized)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: validationMessage(
          "Order number must be 4–10 digits (optional suffix like -F1).",
        ),
      });
    }
  });

const customerHistorySchema = z
  .object({
    customerId: z.string().trim().min(1).optional(),
  })
  .passthrough();

const isbnSearchSchema = z
  .object({
    isbn: z.union([z.string(), z.number()]).transform((v) => String(v).trim()),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    const isbn = normalizeIsbn(data.isbn);
    if (!isbn || !isValidIsbnFormat(isbn)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: validationMessage("ISBN must be 10 or 13 digits"),
      });
    }
  });

const titleSearchSchema = z
  .object({
    title: z.string().trim().min(1, validationMessage("Book title is required")),
  })
  .passthrough();

const cartItemSchema = z
  .object({
    title: z.string().optional(),
    variant_id: z.string().optional(),
    product_id: z.string().optional(),
    isbn: z.string().optional(),
    unit_price: z.union([z.string(), z.number()]).optional(),
    quantity: z.number().optional(),
  })
  .passthrough();

const updateCartItemQuantitySchema = z
  .object({
    action_type: z
      .enum(["add", "set", "minus", "remove", "set_exact", "confirm_remove", "keep"])
      .optional(),
    actionType: z
      .enum(["add", "set", "minus", "remove", "set_exact", "confirm_remove", "keep"])
      .optional(),
    quantity: z.number().optional(),
    confirm_removal: z.boolean().optional(),
    confirmRemoval: z.boolean().optional(),
    item_id: z.string().optional(),
    variant_id: z.string().optional(),
    sku: z.string().optional(),
    title: z.string().optional(),
    product_id: z.string().optional(),
    isbn: z.string().optional(),
    unit_price: z.union([z.string(), z.number()]).optional(),
    price: z.union([z.string(), z.number()]).optional(),
    set_absolute_quantity: z.boolean().optional(),
    items: z.array(cartItemSchema).optional(),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    const action = String(data.action_type ?? data.actionType ?? "").trim();
    if (!action && data.set_absolute_quantity !== true && data.confirm_removal !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: validationMessage("action_type is required (add | set | minus | set_exact | remove)"),
      });
    }
    const qty = data.quantity;
    const hasItemQty =
      Array.isArray(data.items) &&
      data.items.some((item) => item.quantity != null);
    if (
      (qty == null || !Number.isFinite(Number(qty))) &&
      !hasItemQty &&
      data.confirm_removal !== true &&
      action !== "confirm_remove" &&
      action !== "keep"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: validationMessage("quantity is required"),
      });
    }
  });

const checkoutEmailSchema = z
  .object({
    customerEmail: z.string().optional(),
    email: z.string().optional(),
    customerName: z.string().optional(),
    name: z.string().optional(),
    items: z
      .array(
        z
          .object({
            variant_id: z.string().optional(),
            variantId: z.string().optional(),
            item_id: z.string().optional(),
            sku: z.string().optional(),
            title: z.string().optional(),
            quantity: z.number().optional(),
          })
          .passthrough(),
      )
      .optional(),
    variant_ids: z.array(z.string()).optional(),
    item_ids: z.array(z.string()).optional(),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    const email = (data.customerEmail ?? data.email ?? "").trim();
    if (email && !isValidCustomerEmail(email)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: validationMessage("customerEmail must be a valid email address"),
      });
    }
  });

const supportEscalationSchema = z
  .object({
    customerName: z.string().optional(),
    customerEmail: z.string().optional(),
    email: z.string().optional(),
    issueSummary: z.string().optional(),
    summary: z.string().optional(),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    const summary = (data.issueSummary ?? data.summary ?? "").trim();
    if (!summary) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: validationMessage("issueSummary is required"),
      });
    }
    const email = (data.customerEmail ?? data.email ?? "").trim();
    if (email && !isValidCustomerEmail(email)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: validationMessage("customerEmail must be a valid email address"),
      });
    }
  });

/** Optional tracking fields some models hallucinate onto dictate_tracking / order tools. */
const trackingGuardSchema = z
  .object({
    trackingNumber: z.string().optional(),
    tracking_id: z.string().optional(),
    trackingId: z.string().optional(),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    const raw = (
      data.trackingNumber ??
      data.tracking_id ??
      data.trackingId ??
      ""
    ).trim();
    if (!raw) return;
    if (looksLikeIsbnAsTracking(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: validationMessage(
          "ISBN must be 10 or 13 digits — do not pass an ISBN as a tracking ID. Use search_shopify_book_by_isbn or dictate_tracking for the session order.",
        ),
      });
      return;
    }
    if (!isValidTrackingNumber(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: validationMessage("trackingNumber is not a valid carrier tracking ID"),
      });
    }
  });

const updatePendingEmailSchema = z
  .object({
    email: z.string().optional(),
    customerEmail: z.string().optional(),
    replace_from: z.string().optional(),
    replace_to: z.string().optional(),
    replaceFrom: z.string().optional(),
    replaceTo: z.string().optional(),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    const email = String(data.email ?? data.customerEmail ?? "").trim();
    const hasSegment =
      Boolean(String(data.replace_from ?? data.replaceFrom ?? "").trim()) &&
      Boolean(String(data.replace_to ?? data.replaceTo ?? "").trim());
    if ((!email || !isValidCustomerEmail(email)) && !hasSegment) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: validationMessage(
          "email must be a valid customer email address (or provide replace_from + replace_to)",
        ),
      });
    }
  });

const TOOL_SCHEMAS: Record<LlmToolName, z.ZodTypeAny> = {
  get_shopify_order_status: orderStatusSchema,
  get_customer_history: customerHistorySchema,
  search_shopify_book_by_isbn: isbnSearchSchema,
  search_shopify_book_by_title: titleSearchSchema,
  dictate_tracking: trackingGuardSchema,
  update_cart_item_quantity: updateCartItemQuantitySchema,
  get_cart_summary: emptyArgsSchema,
  send_checkout_email: checkoutEmailSchema,
  send_support_escalation: supportEscalationSchema,
  update_pending_email: updatePendingEmailSchema,
  end_call: emptyArgsSchema,
};

/**
 * Pull trust-sensitive fields from UnifiedCallSession — never trust the LLM
 * for isVerifiedCaller / customer identity / confirmed checkout email.
 */
export function injectSecureToolContext(
  tool: LlmToolName,
  rawArgs: Record<string, unknown>,
  session?: CallSession,
): Record<string, unknown> {
  const args: Record<string, unknown> = { ...rawArgs };

  // Strip any LLM-supplied security claims
  delete args.isVerifiedCaller;
  delete args.verified;
  delete args.is_verified_caller;

  if (!session) return args;

  if (tool === "get_customer_history") {
    const sessionCustomerId = session.shopifyCustomerId?.trim();
    // Session identity always wins — never let the LLM swap to another customer.
    if (sessionCustomerId) {
      args.customerId = sessionCustomerId;
    }
  }

  if (tool === "send_checkout_email" || tool === "send_support_escalation") {
    const confirmed =
      session.emailConfirmation?.confirmedEmail?.trim() ||
      session.emailConfirmation?.normalizedEmail?.trim() ||
      "";
    if (confirmed && isValidCustomerEmail(confirmed)) {
      args.customerEmail = confirmed;
      delete args.email;
    }
  }

  return args;
}

export type PrepareToolResult =
  | {
      ok: true;
      tool: LlmToolName;
      args: Record<string, unknown>;
      session?: CallSession;
    }
  | {
      ok: false;
      record: LlmToolExecutionRecord;
    };

/**
 * Resolve session, inject secure context, Zod-validate — before Shopify/Resend.
 */
export function prepareUnifiedToolArgs(
  tool: LlmToolName,
  rawArgs: Record<string, unknown>,
  callSid: string,
  session?: CallSession,
): PrepareToolResult {
  const started = Date.now();
  const resolvedSession = session ?? getUnifiedSession(callSid);
  const injected = injectSecureToolContext(tool, rawArgs ?? {}, resolvedSession);
  const schema = TOOL_SCHEMAS[tool];

  if (!schema) {
    return {
      ok: false,
      record: {
        tool,
        args: {},
        ok: false,
        status: "invalid_format",
        errorMessage: validationMessage(`Unknown tool "${tool}"`),
        elapsedMs: Date.now() - started,
      },
    };
  }

  const parsed = schema.safeParse(injected);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const message = validationMessage(
      first?.message?.replace(/^Validation Error:\s*/i, "") ?? "Invalid tool arguments",
    );
    const stringArgs = Object.fromEntries(
      Object.entries(injected).map(([k, v]) => [
        k,
        typeof v === "string" ? v : v == null ? "" : JSON.stringify(v),
      ]),
    );
    return {
      ok: false,
      record: {
        tool,
        args: stringArgs,
        ok: false,
        status: "invalid_format",
        errorMessage: message,
        data: {
          status: "api_error",
          message,
          error: message,
        },
        elapsedMs: Date.now() - started,
      },
    };
  }

  const validated =
    parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)
      ? (parsed.data as Record<string, unknown>)
      : injected;

  return {
    ok: true,
    tool,
    args: validated,
    session: resolvedSession,
  };
}

export function listRegisteredToolNames(): LlmToolName[] {
  return Object.keys(TOOL_SCHEMAS) as LlmToolName[];
}
