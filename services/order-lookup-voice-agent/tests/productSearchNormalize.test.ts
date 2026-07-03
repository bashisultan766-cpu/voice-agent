import { beforeEach, describe, expect, it } from "vitest";
import {
  digitizeSpeechForIsbn,
  extractIsbnFromSpeech,
} from "../src/utils/productSearchNormalize.js";
import { parseProductSlotsFromSpeech } from "../src/agents/productSlotPhase.js";
import {
  atomicMergeTurnState,
  clearAllCallStates,
  getOrCreateCallState,
  mergeTurnIntoCallState,
  saveCallState,
  syncSlotsToProductMemory,
  validateProductSlotState,
} from "../src/memory/callStateStore.js";
import { clearAllCallMemories, getOrCreateMemory } from "../src/memory/callMemoryStore.js";
import { enablePipelineGuardForTests, resetPipelineGuard } from "../src/guards/pipelineGuard.js";

const SAMPLE_ISBN13 = "9783161484100";

describe("extractIsbnFromSpeech", () => {
  it("parses compact 13-digit ISBN", () => {
    expect(extractIsbnFromSpeech(SAMPLE_ISBN13)).toBe(SAMPLE_ISBN13);
  });

  it("parses spaced ISBN from STT", () => {
    expect(extractIsbnFromSpeech("978 316 1484100")).toBe(SAMPLE_ISBN13);
  });

  it("parses spoken digit words (voice)", () => {
    const spoken =
      "nine seven eight three one six one four eight four one zero zero";
    expect(extractIsbnFromSpeech(spoken)).toBe(SAMPLE_ISBN13);
  });

  it("parses mixed numeric tokens and spoken words", () => {
    expect(extractIsbnFromSpeech("978 three one six 1484100")).toBe(SAMPLE_ISBN13);
  });

  it("digitizeSpeechForIsbn collapses spoken digits", () => {
    expect(digitizeSpeechForIsbn("nine seven eight three one six")).toBe("978316");
  });
});

describe("ISBN slot collection from voice", () => {
  beforeEach(() => {
    clearAllCallStates();
    clearAllCallMemories();
    resetPipelineGuard();
    enablePipelineGuardForTests(true);
  });

  it("collects spoken ISBN when awaiting isbn", () => {
    const callSid = "CA_SPOKEN";
    const memory = getOrCreateMemory(callSid);
    saveCallState({
      ...getOrCreateCallState(callSid),
      intent: "product",
      awaitingInput: "isbn",
    });

    const spoken =
      "nine seven eight three one six one four eight four one zero zero";
    const delta = parseProductSlotsFromSpeech(spoken, "isbn");
    expect(delta.isbn).toBe(SAMPLE_ISBN13);

    const turn = atomicMergeTurnState(
      callSid,
      {
        intent: "product",
        incomingSlots: delta,
        userMessage: spoken,
      },
      memory,
    );

    expect(turn.productMemory.isbnCollected).toBe(true);
    expect(turn.validation.ready).toBe(true);
    expect(turn.productMemory.isbn).toBe(SAMPLE_ISBN13);
  });
});
