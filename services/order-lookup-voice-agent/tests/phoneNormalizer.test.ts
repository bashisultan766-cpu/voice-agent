import { describe, expect, it } from "vitest";
import {
  callerMatchesAnyShopifyPhone,
  normalizePhoneNumber,
  phoneNumbersMatch,
} from "../src/utils/phoneNormalizer.js";
import { applyCallerVerificationFromOrder } from "../src/agents/callerVerification.js";
import type { CallSession } from "../src/types/order.js";
import type { OrderStatusResult } from "../src/adapters/shopifyStorefrontAdapter.js";

describe("normalizePhoneNumber", () => {
  it("strips formatting and US country code", () => {
    expect(normalizePhoneNumber("+1 702-275-8148")).toBe("7022758148");
    expect(normalizePhoneNumber("7022758148")).toBe("7022758148");
    expect(normalizePhoneNumber("(702) 275-8148")).toBe("7022758148");
    expect(normalizePhoneNumber("1-702-275-8148")).toBe("7022758148");
  });

  it("returns empty string for null, undefined, blank, and blocked caller labels", () => {
    expect(normalizePhoneNumber(null)).toBe("");
    expect(normalizePhoneNumber(undefined)).toBe("");
    expect(normalizePhoneNumber("")).toBe("");
    expect(normalizePhoneNumber("   ")).toBe("");
    expect(normalizePhoneNumber("Anonymous")).toBe("");
    expect(normalizePhoneNumber("anonymous")).toBe("");
    expect(normalizePhoneNumber("Restricted")).toBe("");
  });

  it("does not verify when both sides normalize to empty", () => {
    expect(phoneNumbersMatch(null, undefined)).toBe(false);
    expect(phoneNumbersMatch("Anonymous", "")).toBe(false);
    expect(phoneNumbersMatch("Anonymous", "Restricted")).toBe(false);
    expect(phoneNumbersMatch("", "7022758148")).toBe(false);
  });

  it("matches equivalent formatted numbers", () => {
    expect(phoneNumbersMatch("+1 702-275-8148", "7022758148")).toBe(true);
    expect(phoneNumbersMatch("(702) 275-8148", "17022758148")).toBe(true);
    expect(phoneNumbersMatch("7022758148", "7022758149")).toBe(false);
  });
});

describe("callerMatchesAnyShopifyPhone", () => {
  it("matches when caller equals any of the three Shopify phone fields", () => {
    expect(
      callerMatchesAnyShopifyPhone("+1 702-275-8148", [
        undefined,
        "(702) 275-8148",
        "5550001111",
      ]),
    ).toBe(true);
    expect(
      callerMatchesAnyShopifyPhone("7022758148", [
        "5550001111",
        undefined,
        "702-275-8148",
      ]),
    ).toBe(true);
    expect(
      callerMatchesAnyShopifyPhone("7022758148", [
        "5550001111",
        "5550002222",
        undefined,
      ]),
    ).toBe(false);
  });

  it("rejects Anonymous callers even when Shopify phones are blank", () => {
    expect(callerMatchesAnyShopifyPhone("Anonymous", [undefined, "", null])).toBe(false);
  });
});

describe("applyCallerVerificationFromOrder", () => {
  function makeSession(from: string): CallSession {
    return {
      callSid: "CA_VERIFY",
      from,
      to: "+15550000",
      callerPhone: from,
      isVerifiedCaller: false,
      phase: "follow_up",
      orderNumberAttempts: 0,
      createdAt: Date.now(),
    };
  }

  it("marks caller verified when Twilio From matches customer phone", () => {
    const session = makeSession("+1 (702) 275-8148");
    const result: OrderStatusResult = {
      status: "found",
      orderNumber: "#12345",
      customerPhone: "702-275-8148",
      customerId: "gid://shopify/Customer/1",
      totalOrderCount: 10,
    };

    applyCallerVerificationFromOrder(session, result);

    expect(session.isVerifiedCaller).toBe(true);
    expect(session.totalOrderCount).toBe(10);
    expect(session.shopifyCustomerId).toBe("gid://shopify/Customer/1");
  });

  it("marks caller verified when only shipping phone matches", () => {
    const session = makeSession("7022758148");
    const result: OrderStatusResult = {
      status: "found",
      orderNumber: "#12345",
      customerPhone: "5551112222",
      shippingPhone: "(702) 275-8148",
      billingPhone: "5553334444",
    };

    applyCallerVerificationFromOrder(session, result);

    expect(session.isVerifiedCaller).toBe(true);
  });

  it("marks caller unverified when phones do not match", () => {
    const session = makeSession("+15551234567");
    const result: OrderStatusResult = {
      status: "found",
      orderNumber: "#12345",
      customerPhone: "7022758148",
      shippingPhone: "7022758149",
      billingPhone: "7022758150",
      totalOrderCount: 3,
    };

    applyCallerVerificationFromOrder(session, result);

    expect(session.isVerifiedCaller).toBe(false);
  });

  it("marks Anonymous callers unverified without error", () => {
    const session = makeSession("Anonymous");
    const result: OrderStatusResult = {
      status: "found",
      orderNumber: "#12345",
      customerPhone: "7022758148",
    };

    applyCallerVerificationFromOrder(session, result);

    expect(session.isVerifiedCaller).toBe(false);
  });

  it("does not verify when all Shopify phone fields are blank", () => {
    const session = makeSession("");
    const result: OrderStatusResult = {
      status: "found",
      orderNumber: "#12345",
    };

    applyCallerVerificationFromOrder(session, result);

    expect(session.isVerifiedCaller).toBe(false);
  });
});
