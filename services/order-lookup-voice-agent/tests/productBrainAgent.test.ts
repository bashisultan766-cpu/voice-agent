import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleProductBrainTurn } from "../src/agents/productBrainAgent.js";

describe("productBrainAgent", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects direct execution — orchestrator is the only pipeline", async () => {
    await expect(
      handleProductBrainTurn({
        callSid: "CA_BRAIN",
        userMessage: "Harry Potter book",
      }),
    ).rejects.toThrow("ILLEGAL_TOOL_EXECUTION_BYPASS");
  });
});
