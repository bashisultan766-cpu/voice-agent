import { describe, expect, it } from "vitest";
import type { CallSession } from "../src/types/order.js";
import { runCartValidationGate } from "../src/agents/cartValidationGate.js";
import {
  acknowledgeFailureState,
  hasUnacknowledgedFailure,
  recordFailureState,
} from "../src/agents/failureState.js";
import { ensureSessionMemory } from "../src/agents/sessionMemory.js";
import { applySessionCartQuantity } from "../src/agents/orderLookupWorkflow.js";
import { SHOSHAN_SYSTEM_PROMPT } from "../src/prompts/systemPrompt.js";
import { VERIFICATION_SILENCE_PROMPT_MS } from "../src/streaming/audioProcessor.js";

function makeSession(callSid = "CA_ATOMIC"): CallSession {
  return {
    callSid,
    from: "+1",
    to: "+2",
    phase: "follow_up",
    orderNumberAttempts: 0,
    createdAt: Date.now(),
    facilityType: "federal",
    isVerifiedCaller: false,
  } as CallSession;
}

describe("v2026 Core Operating Principles", () => {
  it("system prompt includes CORE OPERATING PRINCIPLES", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/CORE OPERATING PRINCIPLES/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/CartValidationGate/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/FAILURE_STATE/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/3 seconds/i);
  });

  it("verification silence prompt is 3 seconds", () => {
    expect(VERIFICATION_SILENCE_PROMPT_MS).toBe(3000);
  });

  it("CartValidationGate blocks payment without confirmed email", () => {
    const session = makeSession();
    applySessionCartQuantity(
      session,
      {
        variant_id: "gid://shopify/ProductVariant/1",
        title: "Dad to Son",
        unit_price: "12.00",
        inventoryQuantity: 5,
      },
      1,
      "add",
      { facilityType: "federal" },
    );

    const gate = runCartValidationGate(session, {
      requireConfirmedEmail: true,
      liveInventory: { "gid://shopify/ProductVariant/1": 5 },
    });
    expect(gate.ok).toBe(false);
    expect(gate.failureState).toBe("EMAIL_UNCONFIRMED");
  });

  it("FAILURE_STATE must be acknowledged before retry", () => {
    const session = makeSession();
    recordFailureState(session, "EMAIL_SEND_FAILED", "Could not send checkout email.");
    expect(hasUnacknowledgedFailure(session)).toBe(true);

    const blocked = runCartValidationGate(session, {
      requireConfirmedEmail: false,
      skipFailureAckCheck: false,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.failureState).toBe("UNACKNOWLEDGED_FAILURE");

    acknowledgeFailureState(session);
    expect(ensureSessionMemory(session).failureAcknowledged).toBe(true);
  });

  it("CartValidationGate passes when email confirmed and stock ok", () => {
    const session = makeSession("CA_GATE_OK");
    applySessionCartQuantity(
      session,
      {
        variant_id: "gid://shopify/ProductVariant/9",
        title: "Keep Me",
        unit_price: "10.00",
        inventoryQuantity: 10,
      },
      1,
      "add",
      { facilityType: "federal" },
    );
    session.emailConfirmation = {
      phase: "confirmed",
      confirmationStatus: "confirmed",
      confirmedEmail: "a@b.com",
      normalizedEmail: "a@b.com",
      workflowType: "payment_link",
    } as CallSession["emailConfirmation"];

    const gate = runCartValidationGate(session, {
      requireConfirmedEmail: true,
      liveInventory: { "gid://shopify/ProductVariant/9": 10 },
      skipFailureAckCheck: true,
    });
    expect(gate.ok).toBe(true);
  });
});
