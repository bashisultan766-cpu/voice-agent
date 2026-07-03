import { describe, expect, it } from "vitest";
import { resolveExecutionFlow } from "../src/runtime/turnObservability.js";

describe("turnObservability", () => {
  it("resolves mixed flow when product and order signals coexist", () => {
    expect(resolveExecutionFlow("product", "#12345", true)).toBe("MIXED_FLOW");
    expect(resolveExecutionFlow("product", null, true)).toBe("PRODUCT_FLOW");
    expect(resolveExecutionFlow("order", "#12345", false)).toBe("ORDER_FLOW");
    expect(resolveExecutionFlow("unknown", null, false)).toBe("UNKNOWN_FLOW");
  });
});
