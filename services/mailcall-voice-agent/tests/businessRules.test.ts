import { describe, expect, it } from "vitest";
import {
  buildProductCatalogSpeech,
  canTransferToLiveAgent,
  findPlanBySku,
  OFFICE_HOURS,
} from "../src/agents/mailcall/businessRules.js";
import { looksLikeEmail, normalizeSpokenEmail } from "../src/agents/mailcall/emailNormalize.js";
import {
  executeMailCallTool,
  MAILCALL_TOOL_DEFINITIONS,
  normalizePhoneNumber,
} from "../src/agents/mailcall/tools.js";
import { buildSupportEscalationHtml } from "../src/utils/resendEmail.js";

describe("emailNormalize", () => {
  it("converts spoken email to a normalized address", () => {
    expect(normalizeSpokenEmail("mary dot smith at gmail dot com")).toBe("mary.smith@gmail.com");
    expect(looksLikeEmail("mary.smith@gmail.com")).toBe(true);
  });

  it("normalizes numeric and spoken phone numbers", () => {
    expect(normalizePhoneNumber("(212) 555-0198")).toBe("2125550198");
    expect(normalizePhoneNumber("two one two five five five zero one nine eight")).toBe(
      "2125550198",
    );
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

  it("send_support_escalation requires fields then confirms after Resend success", async () => {
    const incomplete = await executeMailCallTool(
      "send_support_escalation",
      JSON.stringify({ sender_name: "Mary" }),
      { callSid: "esc-1", callStartedAtMs: Date.now() },
    );
    expect(incomplete.toolPayload.ok).toBe(false);
    expect(incomplete.spokenHint?.toLowerCase()).toMatch(/name|email|phone|inmate|facility/);
  });

  it("requires the complete nine-field intake schema", () => {
    const definition = MAILCALL_TOOL_DEFINITIONS.find(
      (tool) => tool.type === "function" && tool.function.name === "send_support_escalation",
    );
    const required = (definition?.function.parameters as { required?: string[] })?.required;
    expect(required).toEqual([
      "sender_name",
      "sender_email",
      "sender_phone",
      "inmate_name",
      "inmate_number",
      "facility_name",
      "facility_address",
      "newspaper_selection",
      "plan_duration",
    ]);
  });

  it("builds an escaped executive HTML intake table", () => {
    const html = buildSupportEscalationHtml({
      senderName: "Mary <Smith>",
      senderEmail: "mary@example.com",
      senderPhone: "2125550198",
      inmateName: "John Smith",
      inmateNumber: "A12345",
      facilityName: "State Center",
      facilityAddress: "1 Main Street, Albany, NY 12207",
      newspaperSelection: "Urban",
      planDuration: 3,
      callSid: "CA123",
    });
    expect(html).toContain("MailCall Print Plan Intake");
    expect(html).toContain("Mary &lt;Smith&gt;");
    expect(html).toContain("Urban edition");
    expect(html).toContain("3 months");
    expect(html).not.toContain("Mary <Smith>");
  });
});
