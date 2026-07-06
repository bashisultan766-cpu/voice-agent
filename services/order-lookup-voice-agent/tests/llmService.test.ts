import { describe, expect, it } from "vitest";
import {
  classifyFollowUpIntent,
  isExplicitGoodbyeUtterance,
} from "../src/services/llmService.js";

describe("isExplicitGoodbyeUtterance", () => {
  it("treats explicit farewells as goodbye", () => {
    expect(isExplicitGoodbyeUtterance("goodbye")).toBe(true);
    expect(isExplicitGoodbyeUtterance("bye for now")).toBe(true);
    expect(isExplicitGoodbyeUtterance("see you later")).toBe(true);
    expect(isExplicitGoodbyeUtterance("please hang up")).toBe(true);
    expect(isExplicitGoodbyeUtterance("that's all, thanks")).toBe(true);
  });

  it("does not treat bare no as goodbye", () => {
    expect(isExplicitGoodbyeUtterance("no")).toBe(false);
    expect(isExplicitGoodbyeUtterance("no thanks")).toBe(false);
    expect(isExplicitGoodbyeUtterance("nope")).toBe(false);
    expect(isExplicitGoodbyeUtterance("no, I don't need more copies")).toBe(false);
  });
});

describe("classifyFollowUpIntent", () => {
  it("does not classify bare no as goodbye", async () => {
    await expect(classifyFollowUpIntent("no")).resolves.toBe("other");
    await expect(classifyFollowUpIntent("no, that's fine")).resolves.toBe("other");
  });

  it("classifies explicit goodbye", async () => {
    await expect(classifyFollowUpIntent("bye")).resolves.toBe("goodbye");
  });
});
