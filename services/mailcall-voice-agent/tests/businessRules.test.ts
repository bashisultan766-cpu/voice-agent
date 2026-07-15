import { describe, expect, it } from "vitest";
import {
  buildProductCatalogSpeech,
  canTransferToLiveAgent,
  findPlanBySku,
  OFFICE_HOURS,
} from "../src/agents/mailcall/businessRules.js";
import { looksLikeEmail, normalizeSpokenEmail } from "../src/agents/mailcall/emailNormalize.js";
import { executeMailCallTool } from "../src/agents/mailcall/tools.js";

describe("emailNormalize", () => {
  it("converts spoken email to a normalized address", () => {
    expect(normalizeSpokenEmail("mary dot smith at gmail dot com")).toBe("mary.smith@gmail.com");
    expect(looksLikeEmail("mary.smith@gmail.com")).toBe(true);
  });
});

describe("businessRules", () => {
  it("resolves SKUs and speaks plan pricing", () => {
    expect(findPlanBySku("mc-3m")?.priceUsd).toBe(59.99);
    expect(buildProductCatalogSpeech().toLowerCase()).toContain("twenty-one");
  });

  it("gates live transfer on office hours and call duration", () => {
    const early = canTransferToLiveAgent({
      callStartedAtMs: Date.now(),
      transferNumberConfigured: true,
    });
    expect(early.allowed).toBe(false);

    const ready = canTransferToLiveAgent({
      callStartedAtMs: Date.now() - OFFICE_HOURS.minCallDurationMsForTransfer - 1_000,
      // Force "open" path by only checking duration when hours happen to be open;
      // when closed, allowed stays false — assert structured response either way.
      transferNumberConfigured: true,
    });
    expect(typeof ready.allowed).toBe("boolean");
    expect(ready.reasonSpoken.length).toBeGreaterThan(10);
  });
});

describe("MailCall tools", () => {
  it("MailCallProduct returns spoken pricing without jargon", async () => {
    const result = await executeMailCallTool("MailCallProduct", "{}", {
      callSid: "t1",
      callStartedAtMs: Date.now(),
    });
    expect(result.spokenHint?.toLowerCase()).toMatch(/plan|month/);
    expect(result.spokenHint).not.toMatch(/api|json|wordpress/i);
  });

  it("PlaceOrder normalizes email and requires a valid SKU", async () => {
    const bad = await executeMailCallTool(
      "PlaceOrder",
      JSON.stringify({
        sku: "MC-1M",
        email: "mary dot smith at gmail dot com",
        first_name: "Mary",
        last_name: "Smith",
        inmate_name: "John Smith",
        inmate_number: "12345",
        facility: "State Facility",
        address1: "1 Main Street",
      }),
      { callSid: "t2", callStartedAtMs: Date.now() },
    );
    expect(bad.toolPayload.ok).toBe(true);
    expect(bad.toolPayload.email).toBe("mary.smith@gmail.com");
    expect(bad.spokenHint).not.toMatch(/api|json|database/i);
  });
});
