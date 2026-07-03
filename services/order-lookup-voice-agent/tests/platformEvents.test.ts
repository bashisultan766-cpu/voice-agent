import { beforeEach, describe, expect, it } from "vitest";
import {
  beginCallTurn,
  captureCallSnapshotFromStores,
  clearAllCallEventSessions,
  detectIsbnPartialCleared,
  dispatchAgentEvent,
  loadCallEventsSince,
} from "../src/platform/eventDispatcher.js";
import { parseAgentEvent } from "../src/platform/events.js";
import { clearAllCallMemories, getOrCreateMemory } from "../src/memory/callMemoryStore.js";
import { clearAllCallStates, getOrCreateCallState } from "../src/memory/callStateStore.js";
import { markCallSessionActive } from "../src/voice/callSessionLock.js";

describe("platform events", () => {
  const callSid = "CA_platform_test";

  beforeEach(() => {
    clearAllCallEventSessions();
    clearAllCallMemories();
    clearAllCallStates();
    markCallSessionActive(callSid);
  });

  it("parses the AgentEvent discriminated union", () => {
    const event = parseAgentEvent({
      type: "TURN_INGESTED",
      payload: { textLength: 12, source: "orchestrator" },
    });
    expect(event.type).toBe("TURN_INGESTED");
  });

  it("rejects invalid event payloads", () => {
    expect(() =>
      parseAgentEvent({
        type: "TOOL_EXECUTION_COMPLETED",
        payload: { tool: "x", status: "bogus", resultCount: 0 },
      }),
    ).toThrow();
  });

  it("detects partial ISBN accumulator cleared by complete ISBN", () => {
    const memory = getOrCreateMemory(callSid);
    memory.product.isbn = "97831614841";
    memory.product.isbnCollected = false;
    getOrCreateCallState(callSid).slots.isbn = "97831614841";
    const before = captureCallSnapshotFromStores(callSid);

    memory.product.isbn = "9783161484100";
    memory.product.isbnCollected = true;
    getOrCreateCallState(callSid).slots.isbn = "9783161484100";
    const after = captureCallSnapshotFromStores(callSid);

    expect(detectIsbnPartialCleared(before, after)).toBe(true);
  });

  it("does not flag isbnPartialCleared when no prior partial existed", () => {
    const before = captureCallSnapshotFromStores(callSid);
    const memory = getOrCreateMemory(callSid);
    memory.product.isbn = "9783161484100";
    memory.product.isbnCollected = true;
    const after = captureCallSnapshotFromStores(callSid);
    expect(detectIsbnPartialCleared(before, after)).toBe(false);
  });

  it("appends lifecycle events in turn order", () => {
    const turnSeq = beginCallTurn(callSid);
    dispatchAgentEvent(
      callSid,
      { type: "TURN_INGESTED", payload: { textLength: 5, source: "orchestrator" } },
      { turnSeq },
    );
    dispatchAgentEvent(callSid, {
      type: "TOOL_SELECTED",
      payload: {
        tool: "searchProductByISBN",
        reason: "slots_ready",
        validationReady: true,
        intent: "product",
        flow: "PRODUCT_FLOW",
      },
    });

    const events = loadCallEventsSince(callSid, 1);
    expect(events).toHaveLength(2);
    expect(events[0]?.eventType).toBe("TURN_INGESTED");
    expect(events[1]?.eventType).toBe("TOOL_SELECTED");
    expect(events[0]?.turnSeq).toBe(1);
  });
});
