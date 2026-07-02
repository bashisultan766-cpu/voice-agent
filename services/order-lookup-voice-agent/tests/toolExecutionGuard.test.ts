import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertToolExecutionAllowed,
  canExecuteTool,
  enableToolExecutionForTests,
  resetToolExecutionGuard,
  runInPhase2,
  setToolExecutionPhase,
} from "../src/guards/toolExecutionGuard.js";
import { searchProductByISBN } from "../src/tools/shopifyProductTools.js";

describe("toolExecutionGuard", () => {
  beforeEach(() => {
    resetToolExecutionGuard();
    enableToolExecutionForTests(false);
  });

  afterEach(() => {
    resetToolExecutionGuard();
  });

  it("blocks tools during PHASE_1", () => {
    setToolExecutionPhase("CA_GUARD", "PHASE_1");
    expect(canExecuteTool()).toBe(false);
    expect(() => assertToolExecutionAllowed("searchProductByISBN")).toThrow("TOOL_BLOCKED_PHASE_1");
  });

  it("allows tools during PHASE_2", () => {
    setToolExecutionPhase("CA_GUARD", "PHASE_2");
    expect(canExecuteTool()).toBe(true);
    expect(() => assertToolExecutionAllowed("searchProductByISBN")).not.toThrow();
  });

  it("runInPhase2 temporarily elevates execution phase", async () => {
    setToolExecutionPhase("CA_GUARD", "PHASE_1");
    await runInPhase2("CA_GUARD", async () => {
      expect(canExecuteTool()).toBe(true);
    });
    expect(canExecuteTool()).toBe(false);
  });

  it("blocks searchProductByISBN without phase 2 context", async () => {
    setToolExecutionPhase("CA_BLOCK", "PHASE_1");
    await expect(searchProductByISBN("9783161484100")).rejects.toThrow("TOOL_BLOCKED_PHASE_1");
  });
});
