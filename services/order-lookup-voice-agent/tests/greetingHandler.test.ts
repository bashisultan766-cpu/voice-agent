import { describe, expect, it } from "vitest";
import {
  buildGreetingResponse,
  buildOrderNumberOfferResponse,
  isOrderNumberOfferUtterance,
  isSocialGreetingUtterance,
} from "../src/handlers/greetingHandler.js";

describe("greetingHandler", () => {
  it("detects social greetings", () => {
    expect(isSocialGreetingUtterance("hello")).toBe(true);
    expect(isSocialGreetingUtterance("how are you")).toBe(true);
    expect(isSocialGreetingUtterance("where is my order")).toBe(false);
  });

  it("detects order number offers without digits", () => {
    expect(isOrderNumberOfferUtterance("I have an order number")).toBe(true);
    expect(isOrderNumberOfferUtterance("order number 21698")).toBe(false);
  });

  it("responds warmly to how are you", () => {
    const speech = buildGreetingResponse("how are you");
    expect(speech).toMatch(/doing great|doing well/i);
    expect(speech).not.toMatch(/order number/i);
  });

  it("offers to collect digits after order number offer", () => {
    expect(buildOrderNumberOfferResponse()).toMatch(/tell me your order number/i);
  });
});
