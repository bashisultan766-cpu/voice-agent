import { describe, expect, it } from "vitest";
import { buildOrderView } from "../src/agents/orderDisclosurePolicy.js";
import { toolResultForLlm, type LlmToolExecutionRecord } from "../src/adapters/llmToolExecutor.js";
import type { CallSession } from "../src/types/order.js";

const SECRET_ADDRESS = "SECRET_ADDR_XYZ";
const SECRET_PHONE = "+15559876543";

function session(): CallSession {
  return {
    callSid: "CA_DISCLOSURE",
    from: SECRET_PHONE,
    to: "+15550000000",
    phase: "active",
    orderNumberAttempts: 0,
    createdAt: Date.now(),
    isVerifiedCaller: false,
  } as CallSession;
}

describe("raw order disclosure invariants", () => {
  it("never exposes protected values to an unverified OrderView", () => {
    const view = buildOrderView(session(), {
      order_number: "1001",
      shipping_address: SECRET_ADDRESS,
      customer_phone: SECRET_PHONE,
    });
    expect(JSON.stringify(view)).not.toContain(SECRET_ADDRESS);
    expect(JSON.stringify(view)).not.toContain(SECRET_PHONE);
  });

  it("serializes only OrderView for the order LLM result", () => {
    const record: LlmToolExecutionRecord = {
      tool: "get_shopify_order_status",
      args: { orderNumber: "1001" },
      ok: true,
      status: "found",
      elapsedMs: 1,
      data: {
        status: "found",
        is_verified_caller: false,
        orderView: { verificationLevel: "unverified", order_number: "1001" },
      },
    };
    const payload = toolResultForLlm(record, { isVerifiedCaller: false });
    expect(payload).not.toContain(SECRET_ADDRESS);
    expect(payload).not.toContain(SECRET_PHONE);
    expect(payload).not.toContain('"data"');
  });

  it("stringified diagnostics never include full address or phone", () => {
    const diagnostics = {
      coreOrder: true,
      tags: false,
      tagList: [] as string[],
      timeline: false,
      timelineEventCount: 0,
      metafields: false,
      metafieldCount: 0,
      customerHistory: false,
      pastOrderCount: 0,
      verified: false,
      callerPhoneLast4: "***6543",
      payloadAccess: "filtered" as const,
    };
    const blob = JSON.stringify({
      diagnostics,
      shipping_address: undefined,
      orderView: buildOrderView(session(), {
        order_number: "1001",
        shipping_address: SECRET_ADDRESS,
        customer_phone: SECRET_PHONE,
      }),
    });
    expect(blob).not.toContain(SECRET_ADDRESS);
    expect(blob).not.toContain(SECRET_PHONE);
    expect(blob).toContain("***6543");
  });
});
