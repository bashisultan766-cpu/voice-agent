import { describe, expect, it, beforeEach } from "vitest";
import { resolveCallerIntent } from "../src/agents/callerIntent.js";
import { isStableOrderLookupStatus } from "../src/agents/orderLookupWorkflow.js";
import { saveActiveOrderContext } from "../src/agents/sessionManager.js";
import type { CallSession } from "../src/types/order.js";

function sessionWithOrder(callSid: string): CallSession {
  const session = {
    callSid,
    from: "+15551234567",
    to: "+15559876543",
    phase: "follow_up",
    greetedThisCall: true,
    isVerifiedCaller: false,
  } as CallSession;
  saveActiveOrderContext(session, {
    order_number: "21698",
    customer_name: "Jane Doe",
    physical_items: [{ title: "Old Order Book", quantity: 1 }],
  });
  return session;
}

describe("catalog vs order intent", () => {
  it("treats buy / book title turns as catalog even with an active order", () => {
    const session = sessionWithOrder("CA_CATALOG_PIVOT");
    expect(resolveCallerIntent("I want to buy a book", session)).toBe("catalog");
    expect(resolveCallerIntent("please find the book called Harry Potter", session)).toBe(
      "catalog",
    );
    expect(resolveCallerIntent("the title is Rich Dad Poor Dad", session)).toBe("catalog");
  });

  it("does not treat 'I want to order a book' as order_lookup", () => {
    const session = {
      callSid: "CA_ORDER_BOOK",
      from: "+1",
      to: "+1",
      phase: "greeting",
      greetedThisCall: false,
    } as CallSession;
    expect(resolveCallerIntent("I want to order a book", session)).toBe("catalog");
  });
});

describe("order lookup cache stability", () => {
  it("does not treat not_found as cacheable stable status", () => {
    expect(isStableOrderLookupStatus("found")).toBe(true);
    expect(isStableOrderLookupStatus("invalid_format")).toBe(true);
    expect(isStableOrderLookupStatus("not_found")).toBe(false);
    expect(isStableOrderLookupStatus("api_error")).toBe(false);
  });
});
