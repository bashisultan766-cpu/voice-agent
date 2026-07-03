import { describe, expect, it } from "vitest";
import { LLM_ORCHESTRATOR_TEMPERATURE } from "../src/agents/llmConfig.js";

describe("LLM_ORCHESTRATOR_TEMPERATURE", () => {
  it("stays in transactional range to reduce creative drift", () => {
    expect(LLM_ORCHESTRATOR_TEMPERATURE).toBeGreaterThanOrEqual(0.3);
    expect(LLM_ORCHESTRATOR_TEMPERATURE).toBeLessThanOrEqual(0.5);
    expect(LLM_ORCHESTRATOR_TEMPERATURE).toBe(0.4);
  });
});
