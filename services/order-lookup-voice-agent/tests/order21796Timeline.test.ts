import { describe, expect, it } from "vitest";
import { mapGqlOrderNode } from "../src/adapters/shopifyStorefrontAdapter.js";
import {
  buildActiveOrderContextPayload,
  toolResultForLlm,
  type LlmToolExecutionRecord,
} from "../src/adapters/llmToolExecutor.js";
import {
  buildActiveOrderContextSystemMessage,
  saveActiveOrderContext,
} from "../src/agents/sessionManager.js";
import { createCallSession } from "../src/agents/conversationOrchestrator.js";
import {
  extractOrderConfirmationEmail,
  extractRefundNotificationEmail,
  extractTimelineRefundReason,
} from "../src/adapters/orderFieldExtractors.js";
import { parseDeepOrderData } from "../src/utils/orderDataParser.js";
import {
  ORDER_21796_EXPECTED,
  ORDER_21796_GQL_NODE,
} from "./fixtures/order21796.js";

describe("order #21796 deep timeline extraction", () => {
  const events = ORDER_21796_GQL_NODE.events.edges.map((e) => e.node);

  it("extracts jamaicathompson87@gmail.com as the refund notification email", () => {
    expect(extractRefundNotificationEmail(events, [])).toBe(
      "jamaicathompson87@gmail.com",
    );
    expect(extractRefundNotificationEmail(events, [])).not.toBe(
      "jamaica.billing@example.com",
    );
  });

  it("extracts Customer Cancel Order as the refund reason", () => {
    expect(extractTimelineRefundReason(events)).toBe("Customer Cancel Order");
  });

  it("extracts order confirmation email from timeline", () => {
    expect(extractOrderConfirmationEmail(events)).toBe(
      "jamaicathompson87@gmail.com",
    );
  });

  it("parses the full GraphQL node into typed timeline fields", () => {
    const parsed = parseDeepOrderData(ORDER_21796_GQL_NODE);
    expect(parsed.refundNotificationEmail).toBe(
      ORDER_21796_EXPECTED.refundNotificationEmail,
    );
    expect(parsed.refundReason).toBe(ORDER_21796_EXPECTED.refundReason);
    expect(parsed.orderConfirmationEmail).toBe(
      ORDER_21796_EXPECTED.orderConfirmationEmail,
    );
    expect(parsed.events).toContain(
      "Darren Herrington sent a refund notification email to Jamaica Thompson (jamaicathompson87@gmail.com)",
    );
    expect(parsed.events.some((m) => /Customer Cancel Order/i.test(m))).toBe(true);
  });

  it("maps GraphQL node with timeline fields for the adapter", () => {
    const mapped = mapGqlOrderNode(ORDER_21796_GQL_NODE);
    expect(mapped.orderNumber).toBe(ORDER_21796_EXPECTED.orderNumber);
    expect(mapped.refundNotificationEmail).toBe(
      ORDER_21796_EXPECTED.refundNotificationEmail,
    );
    expect(mapped.refundReason).toBe(ORDER_21796_EXPECTED.refundReason);
    expect(mapped.orderConfirmationEmail).toBe(
      ORDER_21796_EXPECTED.orderConfirmationEmail,
    );
    expect(mapped.events).toEqual(
      expect.arrayContaining([
        expect.stringContaining("jamaicathompson87@gmail.com"),
        expect.stringContaining("Customer Cancel Order"),
      ]),
    );
  });

  it("injects events, refund email, and reason into LLM tool payload and session memory", () => {
    const mapped = mapGqlOrderNode(ORDER_21796_GQL_NODE);
    const data = { status: "found" as const, ...mapped };

    const record: LlmToolExecutionRecord = {
      tool: "get_shopify_order_status",
      args: { orderNumber: "21796" },
      ok: true,
      status: "found",
      elapsedMs: 5,
      data,
    };

    const llmPayload = JSON.parse(toolResultForLlm(record)) as {
      data: Record<string, unknown>;
    };
    expect(llmPayload.data.refund_notification_email).toBe(
      "jamaicathompson87@gmail.com",
    );
    expect(llmPayload.data.order_confirmation_email).toBe(
      "jamaicathompson87@gmail.com",
    );
    expect(llmPayload.data.refund_reason).toBe("Customer Cancel Order");
    expect(llmPayload.data.events).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "Darren Herrington sent a refund notification email",
        ),
      ]),
    );

    const sessionPayload = buildActiveOrderContextPayload(data);
    expect(sessionPayload.refund_notification_email).toBe(
      "jamaicathompson87@gmail.com",
    );
    expect(sessionPayload.refund_reason).toBe("Customer Cancel Order");
    expect(sessionPayload.events).toEqual(expect.any(Array));
    expect((sessionPayload.events as string[]).length).toBeGreaterThan(0);

    const session = createCallSession("CA_21796", "+1", "+2");
    saveActiveOrderContext(session, sessionPayload);
    expect(session.currentOrderData?.refund_notification_email).toBe(
      "jamaicathompson87@gmail.com",
    );
    expect(session.currentOrderData?.refund_reason).toBe("Customer Cancel Order");
    expect(session.currentOrderData?.events).toEqual(
      expect.arrayContaining([
        expect.stringContaining("jamaicathompson87@gmail.com"),
      ]),
    );

    const injected = buildActiveOrderContextSystemMessage(sessionPayload);
    expect(injected).toContain("jamaicathompson87@gmail.com");
    expect(injected).toContain("Customer Cancel Order");
    expect(injected).toMatch(/never claim you lack access/i);
  });
});
