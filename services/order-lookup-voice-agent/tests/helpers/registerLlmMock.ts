import { beforeEach } from "vitest";
import { setLlmAgentTurnOverride } from "../../src/adapters/openaiAdapter.js";
import { defaultTestLlmAgentTurn } from "./llmAgentMock.js";

/** Register deterministic LLM tool-calling mock for integration tests. */
export function useLlmAgentMock(): void {
  beforeEach(() => {
    setLlmAgentTurnOverride(defaultTestLlmAgentTurn);
  });
}
