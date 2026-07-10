import { describe, expect, it } from "vitest";
import {
  detectMultiIntentAgenda,
  extractEntities,
  extractIsbnFromStt,
  extractOrderNumberFromStt,
  extractTitleFromStt,
  normalizeAlphanumericOrderId,
  normalizeIsbnFromStt,
  normalizeSpokenNumericSequence,
  sanitizeCatalogTitlePhrase,
  validateShopifyExecutionGate,
} from "../src/nlp/entityExtractor.js";

describe("normalizeSpokenNumericSequence", () => {
  it("collapses spoken digit words", () => {
    expect(normalizeSpokenNumericSequence("one two three four five")).toBe("12345");
  });

  it("drops stray S between spoken digits (STT noise)", () => {
    expect(normalizeSpokenNumericSequence("one two three four S five")).toBe("12345");
  });

  it("maps O/oh to zero", () => {
    expect(normalizeSpokenNumericSequence("oh oh seven")).toBe("007");
    expect(normalizeSpokenNumericSequence("o o seven")).toBe("007");
  });

  it("maps compound tens (twenty → 20, not 2.0)", () => {
    expect(normalizeSpokenNumericSequence("twenty")).toBe("20");
    expect(normalizeSpokenNumericSequence("twenty one six nine eight")).toBe("21698");
  });

  it("maps A/ate to eight", () => {
    expect(normalizeSpokenNumericSequence("ate five")).toBe("85");
    expect(normalizeSpokenNumericSequence("a five")).toBe("85");
  });

  it("maps letter I to one in numeric context", () => {
    expect(normalizeSpokenNumericSequence("i two three")).toBe("123");
  });

  it("preserves inline digit runs", () => {
    expect(normalizeSpokenNumericSequence("order 12 34 56")).toBe("123456");
  });
});

describe("normalizeAlphanumericOrderId", () => {
  it("prefixes hash for spoken order numbers", () => {
    expect(normalizeAlphanumericOrderId("one two three four five")).toBe("#12345");
  });
});

describe("normalizeIsbnFromStt", () => {
  it("normalizes spoken ISBN digits", () => {
    const spoken =
      "nine seven eight three one six one four eight four one zero zero";
    expect(normalizeIsbnFromStt(spoken)).toBe("9783161484100");
  });
});

describe("extractOrderNumberFromStt", () => {
  it("extracts labeled order number", () => {
    expect(extractOrderNumberFromStt("my order number is 12345")).toBe("#12345");
  });

  it("does not extract bare spoken digits without order context", () => {
    expect(extractOrderNumberFromStt("one two three four five")).toBeNull();
  });

  it("extracts spoken order number when awaiting slot", () => {
    expect(
      extractOrderNumberFromStt("one two three four five", { awaitingSlot: true }),
    ).toBe("#12345");
  });

  it("extracts inline digit run", () => {
    expect(extractOrderNumberFromStt("status for 98765")).toBe("#98765");
  });

  it("does not treat conversational for as digit 4 in spoken order numbers", () => {
    expect(extractOrderNumberFromStt("order for two one six nine eight")).toBe("#21698");
    expect(extractOrderNumberFromStt("order for two one six nine eight", { awaitingSlot: true })).toBe(
      "#21698",
    );
  });
});

describe("extractTitleFromStt", () => {
  it("extracts title from looking-for phrase", () => {
    expect(extractTitleFromStt("I'm looking for The Great Gatsby")).toBe(
      "The Great Gatsby",
    );
  });

  it("preserves brand possessives and year ranges", () => {
    expect(
      extractTitleFromStt("I'm looking for Lindy's 2026 to 2027 National College Football"),
    ).toBe("Lindy's 2026 to 2027 National College Football");
    expect(
      extractTitleFromStt("Lindy's 2026 to 2027 National College Football"),
    ).toBe("Lindy's 2026 to 2027 National College Football");
    expect(
      extractTitleFromStt("do you have Lindy's 2026 to 2027 National College Football"),
    ).toBe("Lindy's 2026 to 2027 National College Football");
  });

  it("returns null for order-only utterance", () => {
    expect(extractTitleFromStt("where is my order 12345")).toBeNull();
  });
});

describe("sanitizeCatalogTitlePhrase", () => {
  it("strips filler but keeps apostrophes and years", () => {
    expect(
      sanitizeCatalogTitlePhrase(
        "uhh I am looking for a book called Lindy's 2026 to 2027 National College Football please",
      ),
    ).toBe("Lindy's 2026 to 2027 National College Football");
  });
});

describe("extractIsbnFromStt", () => {
  it("extracts compact ISBN-13", () => {
    expect(extractIsbnFromStt("9783161484100")).toBe("9783161484100");
  });
});

describe("extractEntities intent routing", () => {
  it("routes ISBN when digits present", () => {
    const result = extractEntities("ISBN 9783161484100");
    expect(result.intent).toBe("isbn_search");
    expect(result.isbn).toBe("9783161484100");
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it("routes order status from tracking phrase", () => {
    const result = extractEntities("track my order 54321");
    expect(result.intent).toBe("order_status");
    expect(result.orderNumber).toBe("#54321");
  });

  it("routes title search from book phrase", () => {
    const result = extractEntities("do you have Harry Potter");
    expect(result.intent).toBe("title_search");
    expect(result.title).toBeTruthy();
  });

  it("respects awaiting slot context", () => {
    const result = extractEntities("one two three four five", {
      awaitingSlot: "order_number",
    });
    expect(result.orderNumber).toBe("#12345");
    expect(result.slotType).toBe("order_number");
  });

  it("detects multi-intent agenda for order then product", () => {
    const agenda = detectMultiIntentAgenda(
      "Hi, first check my order status, then I want to buy a book",
    );
    expect(agenda).toContain("order_status");
    expect(agenda).toContain("product_search");
  });

  it("blocks Shopify gate when order intent lacks order number", () => {
    const gate = validateShopifyExecutionGate("order_status", {
      intent: "order_status",
      slotType: "none",
      confidence: 0.6,
    });
    expect(gate.allowed).toBe(false);
    expect(gate.clarificationText).toContain("order number");
  });
});
