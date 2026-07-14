import { describe, expect, it } from "vitest";
import {
  LLM_ORCHESTRATOR_TEMPERATURE,
  getLlmOrchestratorTemperature,
  isLlmStreamingEnabled,
} from "../src/agents/llmConfig.js";

describe("LLM_ORCHESTRATOR_TEMPERATURE", () => {
  it("stays in transactional range to reduce creative drift (production default 0.2)", () => {
    expect(LLM_ORCHESTRATOR_TEMPERATURE).toBeGreaterThanOrEqual(0.1);
    expect(LLM_ORCHESTRATOR_TEMPERATURE).toBeLessThanOrEqual(0.5);
    expect(LLM_ORCHESTRATOR_TEMPERATURE).toBe(0.2);
    expect(getLlmOrchestratorTemperature()).toBe(0.2);
    expect(isLlmStreamingEnabled()).toBe(true);
  });
});
