/**
 * Trace redaction invariants — synthetic secrets are planted in a fake trace
 * payload and we assert none of them appear in the emitted output. If any of
 * these tests fail, protected data can leak into logs / pipeline traces /
 * staging captures.
 */
import { describe, expect, it } from "vitest";
import {
  captureTrace,
  redactSensitive,
  sanitizeLoggerMeta,
} from "../src/platform/traceRedaction.js";

const SECRETS = {
  phone: "+15559876543",
  email: "secret.buyer@example.com",
  address: "742 Evergreen Terrace, Springfield",
  tracking: "1Z999AA10123456784",
  customerGid: "gid://shopify/Customer/1234567890",
  orderNotes: "Deliver after 6 pm, ring twice",
  invoiceUrl: "https://checkout.shopify.com/invoices/inv_abc123",
  paymentToken: "tok_live_ABC12345",
} as const;

function serializedContainsSecret(payload: unknown): string[] {
  const serialized = JSON.stringify(payload);
  const leaks: string[] = [];
  for (const [name, value] of Object.entries(SECRETS)) {
    if (serialized.includes(value)) leaks.push(name);
  }
  return leaks;
}

describe("redactSensitive", () => {
  it("scrubs phones, emails, tracking numbers, and Shopify GIDs from string values", () => {
    const raw = {
      caller: SECRETS.phone,
      contact_email: SECRETS.email,
      last_tracking_id: SECRETS.tracking,
      shopify_customer_id: SECRETS.customerGid,
      order_note: SECRETS.orderNotes,
      invoice_link: SECRETS.invoiceUrl,
      payment_token_hint: SECRETS.paymentToken,
    };
    const redacted = redactSensitive(raw);
    expect(serializedContainsSecret(redacted)).toEqual([]);
  });

  it("collapses raw OrderStatusResult-shaped payloads", () => {
    const raw = {
      order: {
        status: "found",
        orderNumber: "1001",
        customerEmail: SECRETS.email,
        customerPhone: SECRETS.phone,
        lineItems: [{ title: "Book" }],
      },
    };
    const redacted = redactSensitive(raw) as {
      order: { redacted?: string };
    };
    expect(redacted.order.redacted).toBe("raw_order_status_result");
    expect(serializedContainsSecret(redacted)).toEqual([]);
  });

  it("handles arrays and nested structures without leaking", () => {
    const raw = {
      addresses: [
        { shipping_address: SECRETS.address },
        { billing_address: SECRETS.address },
      ],
      history: [
        { tracking_number: SECRETS.tracking, invoice_url: SECRETS.invoiceUrl },
      ],
    };
    const redacted = redactSensitive(raw);
    expect(serializedContainsSecret(redacted)).toEqual([]);
  });

  it("handles cycles without throwing", () => {
    const raw: Record<string, unknown> = { phone: SECRETS.phone };
    raw.self = raw;
    const redacted = redactSensitive(raw) as { self?: unknown };
    expect(redacted.self).toBe("[circular]");
  });

  it("preserves non-sensitive scalar keys", () => {
    const raw = { call_id: "CA_TEST", turn_seq: 12, latency_ms: 200 };
    const redacted = redactSensitive(raw) as Record<string, unknown>;
    expect(redacted.call_id).toBe("CA_TEST");
    expect(redacted.turn_seq).toBe(12);
    expect(redacted.latency_ms).toBe(200);
  });
});

describe("sanitizeLoggerMeta", () => {
  it("redacts protected keys used across log meta fields", () => {
    const meta = {
      phone: SECRETS.phone,
      email: SECRETS.email,
      shipping_address: SECRETS.address,
      note: SECRETS.orderNotes,
      access_token: SECRETS.paymentToken,
    };
    const sanitized = sanitizeLoggerMeta(meta);
    expect(serializedContainsSecret(sanitized)).toEqual([]);
  });
});

describe("captureTrace", () => {
  it("attaches correlation ids and redacts payload", () => {
    const capture = captureTrace({
      callId: "CA_STAGING",
      turnId: "turn_12",
      checkoutPlanId: "plan_1",
      checkoutGroupId: "grp_1",
      operationId: "op_1",
      idempotencyKey: "idem_1",
      requestId: "req_1",
      event: "invoice_sent",
      payload: {
        shipping_address: SECRETS.address,
        tracking_number: SECRETS.tracking,
      },
    });
    expect(capture.callId).toBe("CA_STAGING");
    expect(capture.checkoutPlanId).toBe("plan_1");
    expect(capture.checkoutGroupId).toBe("grp_1");
    expect(capture.operationId).toBe("op_1");
    expect(capture.idempotencyKey).toBe("idem_1");
    expect(capture.requestId).toBe("req_1");
    expect(serializedContainsSecret(capture)).toEqual([]);
    expect(new Date(capture.capturedAt).toString()).not.toBe("Invalid Date");
  });
});
