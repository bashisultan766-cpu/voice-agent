import { describe, expect, it } from "vitest";
import { createInitialAgentState } from "../src/platform/agentState.js";
import { agentStateReducer } from "../src/platform/reducers.js";
import { replayCallTimeline } from "../src/platform/replayEngine.js";
import type { AgentEvent } from "../src/platform/events.js";

describe("agentStateReducer", () => {
  const callSid = "CA_reducer";

  it("appends user message on TURN_INGESTED", () => {
    const initial = createInitialAgentState(callSid);
    const next = agentStateReducer(initial, {
      type: "TURN_INGESTED",
      payload: { textLength: 5, userMessage: "hello" },
    });
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]?.content).toBe("hello");
    expect(next.turnSeq).toBe(1);
  });

  it("merges slots on MEMORY_SYNCD with mergeInput", () => {
    let state = createInitialAgentState(callSid);
    state = agentStateReducer(state, {
      type: "MEMORY_SYNCD",
      payload: {
        mergeInput: {
          intent: "product",
          incomingSlots: { title: "Harry Potter" },
          userMessage: "Harry Potter book",
        },
      },
    });
    expect(state.intent).toBe("product");
    expect(state.slots.title).toBe("Harry Potter");
  });

  it("freezes validation status on VALIDATION_RESULT", () => {
    let state = createInitialAgentState(callSid);
    state = {
      ...state,
      runtime: {
        lastToolExecution: {
          tool: "searchProductByISBN",
          status: "found",
          resultCount: 1,
          products: [{ id: "1", title: "Test Book" }],
        },
      },
    };
    state = agentStateReducer(state, {
      type: "VALIDATION_RESULT",
      payload: { accepted: 1, rejected: 0, passed: true, stage: "post_normalize_isbn" },
    });
    expect(state.runtime.validation?.frozen).toBe(true);
    expect(state.product.lastResultProductId).toBe("1");
  });
});

describe("replayCallTimeline", () => {
  it("rebuilds state from historical events without side effects", () => {
    const events: AgentEvent[] = [
      { type: "TURN_INGESTED", payload: { textLength: 4, userMessage: "book" } },
      {
        type: "MEMORY_SYNCD",
        payload: {
          mergeInput: {
            intent: "product",
            incomingSlots: { isbn: "9783161484100" },
            userMessage: "9783161484100",
          },
        },
      },
      {
        type: "TOOL_SELECTED",
        payload: {
          tool: "searchProductByISBN",
          reason: "ready",
          validationReady: true,
          intent: "product",
          flow: "PRODUCT_FLOW",
          gateDecision: "searchProductByISBN",
        },
      },
    ];

    const terminal = replayCallTimeline(events, { callSid: "CA_replay" });
    expect(terminal.slots.isbn).toBe("9783161484100");
    expect(terminal.product.isbn).toBe("9783161484100");
    expect(terminal.phase).toBe("PHASE_2");
    expect(terminal.runtime.selectedTool).toBe("searchProductByISBN");
  });
});
