import { describe, expect, it } from "vitest";
import {
  isOrderLookupInsistenceUtterance,
  isTransientOrderLookupStatus,
  speechForOrderLookupResult,
} from "../src/agents/orderLookupWorkflow.js";

describe("orderLookupWorkflow", () => {
  it("detects caller insistence on the order number", () => {
    expect(isOrderLookupInsistenceUtterance("this is the correct order number please find it")).toBe(
      true,
    );
    expect(isOrderLookupInsistenceUtterance("order number 12345")).toBe(false);
  });

  it("uses order-specific speech for transient lookup failures", () => {
    const speech = speechForOrderLookupResult({ status: "api_error", message: "down" });
    expect(speech).toMatch(/hiccup pulling that order/i);
    expect(speech).not.toMatch(/catalog system/i);
  });

  it("uses retry speech when caller insists after a transient failure", () => {
    const speech = speechForOrderLookupResult(
      { status: "api_error", message: "down" },
      { insistence: true },
    );
    expect(speech).toMatch(/look that order up again/i);
  });

  it("classifies transient statuses", () => {
    expect(isTransientOrderLookupStatus("api_error")).toBe(true);
    expect(isTransientOrderLookupStatus("found")).toBe(false);
  });
});
