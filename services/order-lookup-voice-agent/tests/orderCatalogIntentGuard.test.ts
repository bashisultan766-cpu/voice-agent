import { describe, expect, it } from "vitest";
import { resolveCallerIntent } from "../src/agents/callerIntent.js";
import { isOrderFieldQuestion } from "../src/agents/orderFollowUpSpeech.js";
import {
  hasConfirmedOrderContext,
  isOrderLookupRequestWithoutNumber,
} from "../src/agents/orderContextPolicy.js";
import { isCatalogShoppingUtterance, extractSpokenCatalogPrice } from "../src/agents/catalogShoppingIntent.js";
import { createCallSession } from "../src/agents/conversationOrchestrator.js";
import type { CallSession } from "../src/types/order.js";
import { saveActiveOrderContext } from "../src/agents/sessionManager.js";
import { ORDER_DISCLOSURE_POLICY_VERSION } from "../src/agents/orderDisclosurePolicy.js";

function confirmedOrderSession(callSid: string): CallSession {
  const session = {
    callSid,
    from: "+15551234567",
    to: "+15559876543",
    phase: "follow_up",
    greetedThisCall: true,
  } as CallSession;
  saveActiveOrderContext(session, {
    order_number: "21698",
    customer_name: "Jane Doe",
    fulfillment_status: "delivered",
  });
  return session;
}

describe("order context policy", () => {
  it("does not treat unconfirmed sessionOrderContext as confirmed context", () => {
    const session = {
      callSid: "CA_UNCONFIRMED",
      sessionOrderContext: {
        orderReferenceId: "99999",
        orderNumber: "99999",
        verificationLevel: "unverified",
        disclosurePolicyVersion: ORDER_DISCLOSURE_POLICY_VERSION,
        orderView: { verificationLevel: "unverified", order_number: "99999", customer_name: "Ghost" },
        fetchedAt: Date.now(),
      },
    } as CallSession;
    expect(hasConfirmedOrderContext(session)).toBe(false);
  });

  it("treats order context as confirmed only after saveActiveOrderContext", () => {
    const session = confirmedOrderSession("CA_CONFIRMED");
    expect(hasConfirmedOrderContext(session)).toBe(true);
  });

  it("does not restore order context from caller memory on new call", () => {
    const session = createCallSession("CA_NEW_CALL", "+15551234567", "+15559876543");
    expect(session.sessionOrderContext).toBeUndefined();
    expect(session.orderContextConfirmed).toBeUndefined();
  });
});

describe("catalog vs order intent guards", () => {
  it("routes book title search to catalog even when stale order exists in session object", () => {
    const session = {
      callSid: "CA_TITLE_SEARCH",
      sessionOrderContext: {
        orderReferenceId: "21698",
        orderNumber: "21698",
        verificationLevel: "unverified",
        disclosurePolicyVersion: ORDER_DISCLOSURE_POLICY_VERSION,
        orderView: { verificationLevel: "unverified", order_number: "21698" },
        fetchedAt: Date.now(),
      },
      phase: "follow_up",
    } as CallSession;
    const utterance = "please find exact book title rich dad poor dad";
    expect(isCatalogShoppingUtterance(utterance)).toBe(true);
    expect(resolveCallerIntent(utterance, session)).toBe("catalog");
    expect(isOrderFieldQuestion(utterance, session)).toBe(false);
  });

  it("asks for order number instead of using stale context for order details requests", () => {
    const session = {
      callSid: "CA_ORDER_DETAILS",
      sessionOrderContext: {
        orderReferenceId: "21698",
        orderNumber: "21698",
        verificationLevel: "unverified",
        disclosurePolicyVersion: ORDER_DISCLOSURE_POLICY_VERSION,
        orderView: { verificationLevel: "unverified", order_number: "21698" },
        fetchedAt: Date.now(),
      },
      phase: "follow_up",
    } as CallSession;
    const utterance = "how can I get details of my order";
    expect(isOrderLookupRequestWithoutNumber(utterance)).toBe(true);
    expect(resolveCallerIntent(utterance, session)).toBe("order_lookup");
    expect(isOrderFieldQuestion(utterance, session)).toBe(false);
  });

  it("allows order field questions only after confirmed lookup this call", () => {
    const session = confirmedOrderSession("CA_FIELD_OK");
    expect(isOrderFieldQuestion("what is the customer name on my order", session)).toBe(true);
    expect(isOrderFieldQuestion("find rich dad poor dad", session)).toBe(false);
  });

  it("parses spoken catalog prices from caller utterances", () => {
    expect(extractSpokenCatalogPrice("I need the book whose price is 9.99 dollars")).toBe(9.99);
    expect(
      isCatalogShoppingUtterance("I need a book whose price is 9.99 dollars"),
    ).toBe(true);
  });
});
