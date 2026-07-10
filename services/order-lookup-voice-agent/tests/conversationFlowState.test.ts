import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAllConversationFlowModes,
  getConversationFlowMode,
  isConfirmKeyword,
  isIntentAllowedInCurrentFlow,
  setConversationFlowMode,
  shouldBlockSupportCrossReference,
  transitionFlowForIntent,
} from "../src/agents/conversationFlowState.js";

describe("conversationFlowState", () => {
  const callSid = "CA_FLOW_TEST";

  beforeEach(() => {
    clearAllConversationFlowModes();
  });

  it("transitions into PURCHASE_FLOW for product intents", () => {
    transitionFlowForIntent(callSid, "product_search");
    expect(getConversationFlowMode(callSid)).toBe("PURCHASE_FLOW");
  });

  it("blocks support intents while PURCHASE_FLOW is active", () => {
    setConversationFlowMode(callSid, "PURCHASE_FLOW");
    expect(isIntentAllowedInCurrentFlow(callSid, "order_lookup")).toBe(false);
    expect(isIntentAllowedInCurrentFlow(callSid, "product_search")).toBe(true);
  });

  it("blocks purchase intents while SUPPORT_FLOW is active", () => {
    setConversationFlowMode(callSid, "SUPPORT_FLOW");
    expect(isIntentAllowedInCurrentFlow(callSid, "product_search")).toBe(false);
    expect(isIntentAllowedInCurrentFlow(callSid, "order_lookup")).toBe(true);
  });

  it("treats confirm keywords in PURCHASE_FLOW as purchase-only (no support cross-ref)", () => {
    setConversationFlowMode(callSid, "PURCHASE_FLOW");
    expect(isConfirmKeyword("yes")).toBe(true);
    expect(shouldBlockSupportCrossReference(callSid, "yes")).toBe(true);
  });
});
