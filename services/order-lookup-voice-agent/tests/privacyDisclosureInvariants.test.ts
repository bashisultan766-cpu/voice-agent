import { describe, expect, it } from "vitest";
import { buildOrderView } from "../src/agents/orderDisclosurePolicy.js";
import { normalizeToE164, validateTwilioRequestSignature } from "../src/agents/callerVerificationService.js";
import type { CallSession } from "../src/types/order.js";

describe("privacy disclosure invariants", () => {
  it("never includes protected address or phone for unverified callers", () => {
    const view = buildOrderView({ isVerifiedCaller: false } as CallSession, {
      order_number: "1", shipping_address: "Synthetic Protected Address", customer_phone: "+15555550123",
    });
    expect(JSON.stringify(view)).not.toContain("Synthetic Protected Address");
    expect(JSON.stringify(view)).not.toContain("15555550123");
  });
  it("fails closed for invalid E.164 input and exposes signature validation", () => {
    expect(normalizeToE164("not a phone")).toBeNull();
    expect(validateTwilioRequestSignature({ authToken: "", signature: "", url: "", params: {} })).toBe(false);
  });
});
