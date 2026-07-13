import { describe, expect, it } from "vitest";
import {
  ORDER_NUMBER_PREFLIGHT_SPEECH,
  TRACKING_ORDER_NUMBER_PREFLIGHT_SPEECH,
  POST_INFORMATION_CLOSING_SPEECH,
  appendProtocolClosing,
  buildOrderNumberPreflightSpeech,
  buildVerificationFirstOrderSpeech,
  requiresOrderNumberPreflight,
} from "../src/agents/orderLookupProtocol.js";
import {
  captureSessionIntent,
  callerAskedForTracking,
} from "../src/agents/sessionMemory.js";
import {
  isFieldAuthorizedForCaller,
  maskEmailForUnverified,
  maskPhoneForUnverified,
  runVerificationGate,
} from "../src/agents/verificationGate.js";
import { normalizeTrackingIdRawSequence } from "../src/utils/trackingIdSequence.js";
import { formatTrackingNumberForTTS } from "../src/utils/ttsFormatter.js";
import { buildOrderStatusTts } from "../src/agents/fulfillmentHandlers.js";
import type { CallSession } from "../src/types/order.js";

function baseSession(overrides?: Partial<CallSession>): CallSession {
  return {
    callSid: "CA_TEST",
    from: "+15551234567",
    to: "+15559876543",
    callerPhone: "+15551234567",
    isVerifiedCaller: false,
    phase: "greeting",
    orderNumberAttempts: 0,
    ...overrides,
  };
}

describe("verification-first protocol", () => {
  it("requires order number preflight before database access", () => {
    expect(
      requiresOrderNumberPreflight("order_lookup", {
        hasOrderNumberInUtterance: false,
        hasConfirmedContext: false,
      }),
    ).toBe(true);
    expect(
      requiresOrderNumberPreflight("tracking_dictation", {
        hasOrderNumberInUtterance: false,
        hasConfirmedContext: false,
        wantsTracking: true,
      }),
    ).toBe(true);
    expect(
      requiresOrderNumberPreflight("order_lookup", {
        hasOrderNumberInUtterance: true,
        hasConfirmedContext: false,
      }),
    ).toBe(false);
    expect(ORDER_NUMBER_PREFLIGHT_SPEECH).toContain("order number");
    expect(TRACKING_ORDER_NUMBER_PREFLIGHT_SPEECH).toContain("tracking ID");
  });

  it("classifies tracking request without order context as order lookup", async () => {
    const { resolveCallerIntent } = await import("../src/agents/callerIntent.js");
    const { isOrderLookupRequestWithoutNumber } = await import(
      "../src/agents/orderContextPolicy.js"
    );
    const utterance = "I want to take my order tracking IT number";
    expect(isOrderLookupRequestWithoutNumber(utterance)).toBe(true);
    expect(resolveCallerIntent(utterance)).toBe("order_lookup");
  });

  it("uses tracking-specific preflight when caller asked for tracking ID", () => {
    const session = baseSession();
    captureSessionIntent(session, "I want my order tracking ID number", "order_lookup");
    expect(buildOrderNumberPreflightSpeech(session)).toBe(TRACKING_ORDER_NUMBER_PREFLIGHT_SPEECH);
  });

  it("preserves tracking intent in session memory", () => {
    const session = baseSession();
    captureSessionIntent(session, "Where is my tracking ID?", "order_lookup");
    expect(session.sessionMemory?.initialIntent).toBe("tracking_id");
    expect(callerAskedForTracking(session)).toBe(true);
  });

  it("emits passive confirmation only — no automatic summary", () => {
    const speech = buildVerificationFirstOrderSpeech({
      orderNumber: "#21698",
      orderPlacedAtSpoken: "March 10th, 2025",
      fulfillmentStatus: "FULFILLED",
      isRefunded: false,
      itemCount: 1,
      lineItems: [{ title: "SureShot Guide", quantity: 1 }],
      feeLineItems: [],
      events: [],
      totalAmount: "25.00 USD",
      financialStatus: "PAID",
      customerEmail: "caller@example.com",
    });
    expect(speech).toBe(
      "I have successfully pulled up order 21698 for the customer. Order status is fulfilled. How can I assist you further with this order?",
    );
    expect(speech).not.toContain("SureShot Guide");
    expect(speech).not.toContain("caller@example.com");
    expect(speech).not.toContain(POST_INFORMATION_CLOSING_SPEECH);
  });

  it("still uses Concierge Gateway when caller asked for tracking (no auto dump)", () => {
    const session = baseSession();
    captureSessionIntent(session, "I need my tracking number", "order_lookup");
    const speech = buildVerificationFirstOrderSpeech(
      {
        orderNumber: "12345",
        orderPlacedAtSpoken: "January 1st, 2025",
        fulfillmentStatus: "FULFILLED",
        trackingNumber: "1Z999AA10123456784",
        isRefunded: false,
        itemCount: 1,
        lineItems: [],
        feeLineItems: [],
        events: [],
      },
      session,
    );
    expect(speech).toMatch(/I have successfully pulled up order 12345/i);
    expect(speech).toMatch(/How can I assist you further with this order/i);
    expect(speech).not.toContain("1Z999");
  });

  it("strips decimal artifacts from tracking IDs", () => {
    expect(normalizeTrackingIdRawSequence("2.0.3.4.5")).toBe("20345");
    const tts = formatTrackingNumberForTTS("2.0.3.4.5");
    expect(tts).not.toContain("2.0");
    expect(tts).toBe("2, 0, 3, 4, 5");
  });

  it("verification gate authorizes vault fields only when phones match", () => {
    const session = baseSession({ callerPhone: "+15551234567" });
    const verified = runVerificationGate(session, {
      status: "found",
      orderNumber: "1001",
      customerPhone: "+15551234567",
    });
    expect(verified).toBe(true);
    expect(isFieldAuthorizedForCaller(session, "shipping_address")).toBe(true);

    const unverifiedSession = baseSession({ callerPhone: "+15550001111" });
    runVerificationGate(unverifiedSession, {
      status: "found",
      orderNumber: "1001",
      customerPhone: "+15551234567",
    });
    expect(isFieldAuthorizedForCaller(unverifiedSession, "shipping_address")).toBe(false);
    expect(isFieldAuthorizedForCaller(unverifiedSession, "tracking_number")).toBe(true);
    expect(isFieldAuthorizedForCaller(unverifiedSession, "line_items")).toBe(true);
    expect(isFieldAuthorizedForCaller(unverifiedSession, "total_amount")).toBe(true);
    expect(isFieldAuthorizedForCaller(unverifiedSession, "shipping_amount")).toBe(true);
    expect(isFieldAuthorizedForCaller(unverifiedSession, "item_price")).toBe(true);
    expect(isFieldAuthorizedForCaller(unverifiedSession, "customer_name")).toBe(true);
    expect(isFieldAuthorizedForCaller(unverifiedSession, "customer_email")).toBe(true);
    expect(isFieldAuthorizedForCaller(unverifiedSession, "payment_method")).toBe(true);
    expect(isFieldAuthorizedForCaller(unverifiedSession, "payment_method_last4")).toBe(true);
    expect(isFieldAuthorizedForCaller(unverifiedSession, "card_last4")).toBe(true);
    expect(maskEmailForUnverified("user@gmail.com")).toBe("...@gmail.com");
    expect(maskPhoneForUnverified("+15551234567")).toBe("*** *** 4567");
  });

  it("buildOrderStatusTts uses Concierge Gateway template", () => {
    const tts = buildOrderStatusTts({
      status: "found",
      orderNumber: "12345",
      orderPlacedAt: "2025-03-10T00:00:00Z",
      fulfillmentStatus: "FULFILLED",
    });
    expect(tts.text).toBe(
      "I have successfully pulled up order 12345 for the customer. Order status is fulfilled. How can I assist you further with this order?",
    );
  });

  it("appendProtocolClosing is idempotent", () => {
    const once = appendProtocolClosing("Status is shipped.");
    const twice = appendProtocolClosing(once);
    expect(once).toBe(twice);
    expect(once).toContain(POST_INFORMATION_CLOSING_SPEECH);
  });
});
