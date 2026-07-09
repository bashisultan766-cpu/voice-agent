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
import { classifyCallerIntent } from "../src/agents/intentClassifier.js";
import { decideToolExecutionWithReason } from "../src/agents/toolDecisionGate.js";
import type { SessionProductMemory } from "../src/memory/callMemoryStore.js";

const emptyMemory = {} as SessionProductMemory;

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

  it("classifies yes as product_search during PURCHASE_FLOW", async () => {
    setConversationFlowMode(callSid, "PURCHASE_FLOW");
    const result = await classifyCallerIntent("yes", { callSid });
    expect(result.intent).toBe("product_search");
    expect(result.flowMode).toBe("PURCHASE_FLOW");
  });

  it("tool gate blocks order lookup during PURCHASE_FLOW", async () => {
    setConversationFlowMode(callSid, "PURCHASE_FLOW");
    const { beginOrchestratorTurn, endOrchestratorTurn } = await import(
      "../src/guards/pipelineGuard.js"
    );
    beginOrchestratorTurn(callSid);
    try {
      const decision = decideToolExecutionWithReason({
        intent: "order",
        phase: "follow_up",
        awaitingInput: null,
        productMemory: emptyMemory,
        validationReady: false,
        explicitRepeat: false,
        wantsRecommendations: false,
        orderNumber: "21698",
        callSid,
      });
      expect(decision.action).toBe("conversationOnly");
    } finally {
      endOrchestratorTurn();
    }
  });
});
