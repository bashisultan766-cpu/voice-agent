import { describe, expect, it } from "vitest";
import { fuzzyOrderNumberCandidates, normalizeOrderNumber } from "../src/utils/inputNormalizer.js";

describe("normalizeOrderNumber", () => {
  it("converts compound spoken numbers to digits", () => {
    expect(normalizeOrderNumber("order twenty one six ninety eight")).toBe("#21698");
  });

  it("converts digit-by-digit speech with suffix", () => {
    expect(normalizeOrderNumber("two one six nine eight dash f one")).toBe("#21698-F1");
  });

  it("strips spaces from spaced digit input", () => {
    expect(normalizeOrderNumber("21 698")).toBe("#21698");
  });

  it("preserves typed numeric order numbers", () => {
    expect(normalizeOrderNumber("45678")).toBe("#45678");
    expect(normalizeOrderNumber("#45678")).toBe("#45678");
    expect(normalizeOrderNumber("21698-F1")).toBe("#21698-F1");
  });

  it("parses spoken digit-by-digit sequences", () => {
    expect(normalizeOrderNumber("four five six seven eight")).toBe("#45678");
    expect(normalizeOrderNumber("two one six nine eight")).toBe("#21698");
  });

  it("returns empty string when too few digits remain", () => {
    expect(normalizeOrderNumber("twelve")).toBe("");
    expect(normalizeOrderNumber("")).toBe("");
  });
});

describe("fuzzyOrderNumberCandidates", () => {
  it("strips non-numeric STT glue so Is 40088 is not stuck as 140088", () => {
    const candidates = fuzzyOrderNumberCandidates("Is 40088");
    expect(candidates[0]).toBe("#40088");
    expect(candidates).toContain("#40088");
  });

  it("also tries stripping a glued leading 1 from 140088", () => {
    const candidates = fuzzyOrderNumberCandidates("140088");
    expect(candidates).toContain("#140088");
    expect(candidates).toContain("#40088");
  });

  it("keeps valid primary candidates first", () => {
    expect(fuzzyOrderNumberCandidates("#21698-F1")[0]).toBe("#21698-F1");
  });
});
