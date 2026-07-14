import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createCallSession, endCallSession } from "../src/agents/conversationOrchestrator.js";
import {
  applyUnifiedWorkflowTransition,
  getUnifiedSession,
  deriveSovereignState,
} from "../src/agents/unifiedCallSession.js";
import { getConversationFlowMode, setConversationFlowMode } from "../src/agents/conversationFlowState.js";
import {
  getOrCreateActiveSession,
  syncActiveSessionFromCallSession,
  updateActiveSession,
} from "../src/sovereign/activeSession.js";
import { shouldPreferLlmPrimaryRouting } from "../src/agents/agentBrain.js";
import { saveActiveOrderContext } from "../src/agents/sessionManager.js";

describe("unified call session (Priority 3 + 6)", () => {
  const callSid = "CA_UNIFIED_TEST";

  beforeEach(() => {
    endCallSession(callSid);
  });

  afterEach(() => {
    endCallSession(callSid);
  });

  it("registers session and mirrors flowMode onto CallSession", () => {
    const session = createCallSession(callSid, "+15551112222", "+15553334444");
    expect(getUnifiedSession(callSid)).toBe(session);
    expect(session.flowMode).toBe("idle");

    setConversationFlowMode(callSid, "PURCHASE_FLOW");
    expect(session.flowMode).toBe("PURCHASE_FLOW");
    expect(getConversationFlowMode(callSid)).toBe("PURCHASE_FLOW");
  });

  it("clears flowMode and registry on endCallSession", () => {
    const session = createCallSession(callSid, "+15551112222", "+15553334444");
    setConversationFlowMode(callSid, "SUPPORT_FLOW");
    endCallSession(callSid, session);
    expect(getUnifiedSession(callSid)).toBeUndefined();
    expect(getConversationFlowMode(callSid)).toBe("idle");
  });

  it("keeps catalog_active when order data exists during purchase flow", () => {
    const session = createCallSession(callSid, "+15551112222", "+15553334444");
    saveActiveOrderContext(session, { order_number: "12345" });
    applyUnifiedWorkflowTransition(session, "product_search", { reason: "test" });

    expect(session.flowMode).toBe("PURCHASE_FLOW");
    expect(session.activeWorkflowContext).toBe("product_search");
    expect(deriveSovereignState(session)).toBe("catalog_active");

    const active = syncActiveSessionFromCallSession(session);
    expect(active.currentState).toBe("catalog_active");
    expect(session.sovereignState).toBe("catalog_active");
  });

  it("clears order-number await when pivoting to product search", () => {
    const session = createCallSession(callSid, "+15551112222", "+15553334444");
    session.phase = "awaiting_order_number";
    session.awaitingInput = "order_number";
    session.lastOrchestratorIntent = "order_lookup";

    applyUnifiedWorkflowTransition(session, "product_search", { reason: "pivot" });

    expect(session.awaitingInput).toBeNull();
    expect(session.phase).toBe("follow_up");
    expect(session.lastOrchestratorIntent).toBe("catalog");
  });

  it("prefers LLM primary routing for catalog intents", () => {
    const session = createCallSession(callSid, "+15551112222", "+15553334444");
    expect(
      shouldPreferLlmPrimaryRouting(session, "looking for Lindy's football preview", "catalog"),
    ).toBe(true);
    expect(shouldPreferLlmPrimaryRouting(session, "how are you", "general_help")).toBe(true);
  });

  it("mirrors ActiveSession updates onto unified sovereignState", () => {
    const session = createCallSession(callSid, "+15551112222", "+15553334444");
    getOrCreateActiveSession(callSid);
    updateActiveSession(callSid, { currentState: "catalog_active", cachedIntent: "catalog" });
    expect(session.sovereignState).toBe("catalog_active");
  });
});
