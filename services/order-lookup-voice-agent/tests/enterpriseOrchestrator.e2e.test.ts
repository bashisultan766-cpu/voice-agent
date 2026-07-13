import { beforeEach, describe, expect, it, vi } from "vitest";
import { runOrchestratorTurn } from "../src/agents/conversationOrchestrator.js";
import { createCallSession } from "../src/agents/orderAgent.js";
import { getOrCreateActiveSession, recordTrackingPayload } from "../src/sovereign/activeSession.js";
import { TRACKING_DICTATION_CONFIRM_SPEECH } from "../src/agents/dictationTool.js";
import { saveActiveOrderContext } from "../src/agents/sessionManager.js";
import { clearAllCallMemories } from "../src/memory/callMemoryStore.js";
import { clearAllCallStates } from "../src/memory/callStateStore.js";
import { clearAllCallEventSessions } from "../src/platform/eventDispatcher.js";
import { clearAllTurnQueues } from "../src/runtime/turnExecutionQueue.js";
import { clearAllStreamBarriers } from "../src/runtime/streamTurnBarrier.js";
import { clearAllTurnHealth } from "../src/runtime/turnHealthMonitor.js";
import { resetPipelineGuard, enablePipelineGuardForTests } from "../src/guards/pipelineGuard.js";
import { resetToolExecutionGuard } from "../src/guards/toolExecutionGuard.js";
import { resetToolAccessGuard } from "../src/guards/toolAccessGuard.js";
import { setLlmAgentTurnOverride } from "../src/adapters/openaiAdapter.js";
import { defaultTestLlmAgentTurn } from "./helpers/llmAgentMock.js";
import * as shopifyStorefrontAdapter from "../src/adapters/shopifyStorefrontAdapter.js";

const TRACKING = "9449050105795009634765";

async function collectSpeech(
  session: ReturnType<typeof createCallSession>,
  text: string,
): Promise<string> {
  const parts: string[] = [];
  for await (const event of runOrchestratorTurn(session, text)) {
    if (event.type === "chunk") parts.push(event.chunk.text);
  }
  return parts.join(" ");
}

function logPhase(label: string, session: ReturnType<typeof createCallSession>, speech: string): void {
  const active = getOrCreateActiveSession(session.callSid);
  const line = [
    `[E2E] ${label}`,
    `state=${active.currentState}`,
    `notepadReady=${active.isNotepadReady}`,
    `cachedIntent=${active.cachedIntent ?? "none"}`,
    `speech="${speech.slice(0, 120)}${speech.length > 120 ? "…" : ""}"`,
  ].join(" | ");
  console.log(line);
}

describe("enterprise orchestrator phase 3 e2e", () => {
  beforeEach(() => {
    clearAllCallMemories();
    clearAllCallStates();
    clearAllCallEventSessions();
    clearAllTurnQueues();
    clearAllStreamBarriers();
    clearAllTurnHealth();
    resetPipelineGuard();
    enablePipelineGuardForTests(true);
    resetToolExecutionGuard();
    resetToolAccessGuard();
    setLlmAgentTurnOverride(defaultTestLlmAgentTurn);
    vi.restoreAllMocks();
  });

  it("transitions notepad dictation → order history without looping", async () => {
    const session = createCallSession("CA_E2E_ORCH", "+15551234567", "+18005551212");
    session.greetedThisCall = true;
    session.phase = "follow_up";
    session.isVerifiedCaller = true;
    session.shopifyCustomerId = "gid://shopify/Customer/12345";
    saveActiveOrderContext(session, {
      order_number: "21796",
      tracking_number: TRACKING,
      fulfillment_status: "fulfilled",
    });

    recordTrackingPayload(session.callSid, TRACKING);

    const handshake = await collectSpeech(session, "give me the id number");
    logPhase("1-notepad-handshake", session, handshake);
    expect(handshake).toMatch(/ready with pen and (?:notepad|paper)|pen and (?:notepad|paper)|ready for me to read/i);
    expect(getOrCreateActiveSession(session.callSid).currentState).toBe("awaiting_notepad_ready");

    const dictation = await collectSpeech(session, "ready");
    logPhase("2-dictation", session, dictation);
    expect(dictation).toMatch(/get all that|get all of that|write that correctly|should I repeat/i);
    expect(dictation).toContain(TRACKING_DICTATION_CONFIRM_SPEECH);
    expect(getOrCreateActiveSession(session.callSid).currentState).toBe("tracking_dictation");

    const complete = await collectSpeech(session, "yes I have written it down thank you");
    logPhase("3-tracking-complete", session, complete);
    expect(complete).toMatch(/how else can I help you today/i);
    expect(complete).not.toMatch(/pen and notepad/i);
    const afterComplete = getOrCreateActiveSession(session.callSid);
    expect(afterComplete.currentState).toBe("order_active");
    expect(afterComplete.isNotepadReady).toBe(false);
    expect(afterComplete.cachedIntent).toBe("order");

    vi.spyOn(shopifyStorefrontAdapter, "getCustomerHistory").mockResolvedValue({
      status: "found",
      orderCount: 2,
      orders: [
        {
          orderNumber: "21796",
          monthYear: "January 2025",
          totalAmount: "$42.00",
          status: "fulfilled",
          items: ["Test Book"],
        },
        {
          orderNumber: "21001",
          monthYear: "March 2025",
          totalAmount: "$18.50",
          status: "refunded",
          items: ["Another Book"],
        },
      ],
    });

    setLlmAgentTurnOverride(async (input) => {
      if (/\b(order history|past orders|previous orders)\b/i.test(input.userMessage)) {
        const { executeLlmTool } = await import("../src/adapters/llmToolExecutor.js");
        const exec = await executeLlmTool(
          "get_customer_history",
          { customerId: session.shopifyCustomerId ?? "" },
          input.callSid,
          session,
        );
        return {
          speech:
            "You have orders in January 2025 and March 2025. Which month would you like me to walk through?",
          toolExecutions: [exec],
          responseType: "order_found",
        };
      }
      return defaultTestLlmAgentTurn(input);
    });

    const history = await collectSpeech(session, "what is my order history");
    logPhase("4-order-history", session, history);
    expect(history).toMatch(/January 2025|March 2025|month/i);
    expect(history).not.toMatch(/pen and notepad/i);
    expect(history).not.toMatch(/write that correctly/i);

    const afterHistory = getOrCreateActiveSession(session.callSid);
    expect(afterHistory.currentState).toBe("order_active");
    expect(shopifyStorefrontAdapter.getCustomerHistory).toHaveBeenCalledOnce();
  });
});
