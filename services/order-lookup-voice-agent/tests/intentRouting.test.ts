import { beforeEach, describe, expect, it } from "vitest";
import { runOrchestratorTurn } from "../src/agents/conversationOrchestrator.js";
import { createCallSession } from "../src/agents/orderAgent.js";
import { resolveCallerIntent } from "../src/agents/callerIntent.js";
import { saveActiveOrderContext } from "../src/agents/sessionManager.js";
import { isExplicitTrackingDictationRequest } from "../src/agents/trackingIntent.js";
import {
  getOrCreateActiveSession,
  recordTrackingPayload,
  updateActiveSession,
} from "../src/sovereign/activeSession.js";
import { clearAllCallMemories } from "../src/memory/callMemoryStore.js";
import { clearAllCallStates } from "../src/memory/callStateStore.js";
import { clearAllCallEventSessions } from "../src/platform/eventDispatcher.js";
import { clearAllTurnQueues } from "../src/runtime/turnExecutionQueue.js";
import { clearAllStreamBarriers } from "../src/runtime/streamTurnBarrier.js";
import { clearAllTurnHealth } from "../src/runtime/turnHealthMonitor.js";
import { resetPipelineGuard, enablePipelineGuardForTests } from "../src/guards/pipelineGuard.js";
import { resetToolExecutionGuard } from "../src/guards/toolExecutionGuard.js";
import { resetToolAccessGuard } from "../src/guards/toolAccessGuard.js";

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

function seedOrderSession(callSid: string) {
  const session = createCallSession(callSid, "+15551234567", "+18005551212");
  session.greetedThisCall = true;
  session.phase = "follow_up";
  session.isVerifiedCaller = true;
  saveActiveOrderContext(session, {
    order_number: "21796",
    customer_name: "Jamaica Thompson",
    tracking_number: TRACKING,
    fulfillment_status: "fulfilled",
  });
  updateActiveSession(callSid, { currentState: "order_active", cachedIntent: "order" });
  return session;
}

describe("resolveCallerIntent", () => {
  it("classifies customer name as order_field_query", () => {
    const session = seedOrderSession("CA_INTENT_NAME");
    expect(resolveCallerIntent("what is the customer name", session)).toBe("order_field_query");
  });

  it("classifies explicit tracking requests as tracking_dictation when order is on file", () => {
    const session = seedOrderSession("CA_INTENT_TRACK");
    expect(resolveCallerIntent("give me the tracking id number", session)).toBe(
      "tracking_dictation",
    );
  });

  it("classifies tracking requests as order_lookup when no order is on file", () => {
    const session = createCallSession("CA_INTENT_TRACK_COLD", "+15551234567", "+18005551212");
    expect(resolveCallerIntent("I want my order tracking IT number", session)).toBe("order_lookup");
  });

  it("does not treat where is my order as tracking when context exists", () => {
    const session = seedOrderSession("CA_INTENT_STATUS");
    expect(resolveCallerIntent("where is my order", session)).toBe("order_field_query");
    expect(isExplicitTrackingDictationRequest("where is my order")).toBe(false);
  });
});

describe("intent-first orchestrator routing", () => {
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
  });

  it("answers customer name without notepad handshake when order is active", async () => {
    const session = seedOrderSession("CA_ROUTE_NAME");
    const speech = await collectSpeech(session, "what is the customer name");
    console.log(`[INTENT-E2E] customer_name | state=${getOrCreateActiveSession(session.callSid).currentState} | speech="${speech}"`);
    expect(speech).toMatch(/Jamaica Thompson/i);
    expect(speech).not.toMatch(/notepad/i);
    expect(speech).not.toMatch(/write that correctly/i);
    expect(getOrCreateActiveSession(session.callSid).currentState).toBe("order_active");
  });

  it("still requires notepad for explicit tracking requests", async () => {
    const session = seedOrderSession("CA_ROUTE_TRACK");
    const speech = await collectSpeech(session, "give me the tracking id number");
    console.log(`[INTENT-E2E] tracking_request | state=${getOrCreateActiveSession(session.callSid).currentState} | speech="${speech.slice(0, 100)}…"`);
    expect(speech).toMatch(/pen and notepad|ready with pen/i);
    expect(getOrCreateActiveSession(session.callSid).currentState).toBe("awaiting_notepad_ready");
  });

  it("recovers from legacy auto-armed tracking trap on customer name", async () => {
    const session = seedOrderSession("CA_ROUTE_TRAP");
    recordTrackingPayload(session.callSid, TRACKING);
    expect(getOrCreateActiveSession(session.callSid).currentState).toBe("awaiting_notepad_ready");

    const speech = await collectSpeech(session, "what is the customer name on this order");
    console.log(`[INTENT-E2E] trap_recovery | state=${getOrCreateActiveSession(session.callSid).currentState} | speech="${speech}"`);
    expect(speech).toMatch(/Jamaica Thompson/i);
    expect(speech).not.toMatch(/notepad/i);
    expect(getOrCreateActiveSession(session.callSid).currentState).toBe("order_active");
  });
});
