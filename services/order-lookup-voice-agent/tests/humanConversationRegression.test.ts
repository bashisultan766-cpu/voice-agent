import { beforeEach, describe, expect, it } from "vitest";
import { runOrchestratorTurn } from "../src/agents/conversationOrchestrator.js";
import { createCallSession } from "../src/agents/orderAgent.js";
import { clearAllCallMemories } from "../src/memory/callMemoryStore.js";
import { clearAllCallStates } from "../src/memory/callStateStore.js";
import { clearAllCallEventSessions } from "../src/platform/eventDispatcher.js";
import { clearAllTurnQueues } from "../src/runtime/turnExecutionQueue.js";
import { clearAllStreamBarriers } from "../src/runtime/streamTurnBarrier.js";
import { clearAllTurnHealth } from "../src/runtime/turnHealthMonitor.js";
import { resetPipelineGuard, enablePipelineGuardForTests } from "../src/guards/pipelineGuard.js";
import { resetToolExecutionGuard } from "../src/guards/toolExecutionGuard.js";
import { resetToolAccessGuard } from "../src/guards/toolAccessGuard.js";
import { mockLiveShopifyFetch } from "./helpers/mockLiveShopify.js";
import { useLlmAgentMock } from "./helpers/registerLlmMock.js";
import { stripRoboticAssistantSpeech } from "../src/agents/conversationBrainAgent.js";
import { isDuplicateSpokenSentence, recordLastSpokenSentence } from "../src/services/llmService.js";

useLlmAgentMock();

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

describe("human conversation regression", () => {
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
    mockLiveShopifyFetch([]);
  });

  it('responds warmly to "hello, how are you?" without asking for order number', async () => {
    const session = createCallSession("CA_WARM", "+1", "+2");
    session.greetedThisCall = true;
    const speech = await collectSpeech(session, "hello, how are you?");
    expect(speech).toMatch(/doing (great|well)/i);
    expect(speech).not.toMatch(/assist you with order/i);
    expect(speech).not.toMatch(/please provide your order number/i);
  });

  it('handles "I have an order number" with a natural prompt', async () => {
    const session = createCallSession("CA_OFFER", "+1", "+2");
    session.greetedThisCall = true;
    const speech = await collectSpeech(session, "I have an order number");
    expect(speech).toMatch(/tell me your order number|go ahead/i);
    expect(speech).not.toMatch(/assist you with order/i);
    expect(session.awaitingInput).toBe("order_number");
  });

  it("strips robotic order-loop phrasing", () => {
    const cleaned = stripRoboticAssistantSpeech(
      "I am here to assist you with order number.",
      "hello",
    );
    expect(cleaned).not.toMatch(/assist you with order/i);
    expect(cleaned).toMatch(/help|Hi there/i);
  });

  it("treats paraphrased order-number asks as duplicates", () => {
    recordLastSpokenSentence("CA_DUP2", "What's your order number? It's usually four to six digits.");
    expect(
      isDuplicateSpokenSentence(
        "CA_DUP2",
        "Please tell me your order number — four to six digits.",
      ),
    ).toBe(true);
  });
});
