import { describe, expect, it } from "vitest";
import {
  buildProductCatalogSpeech,
  canTransferToLiveAgent,
  findPlanBySku,
  OFFICE_HOURS,
} from "../src/agents/mailcall/businessRules.js";
import {
  buildCatalog,
  parsePlansFromCmsText,
} from "../src/agents/mailcall/catalog.js";
import { looksLikeEmail, normalizeSpokenEmail } from "../src/agents/mailcall/emailNormalize.js";
import {
  executeMailCallTool,
  MAILCALL_TOOL_DEFINITIONS,
  normalizePackageType,
  normalizePhoneNumber,
} from "../src/agents/mailcall/tools.js";
import {
  buildCheckoutLinkHtml,
  buildSupportEscalationHtml,
} from "../src/utils/resendEmail.js";

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
    expect(findPlanBySku("mc-3m")?.priceUsd).toBe(53.97);
    expect(buildProductCatalogSpeech().toLowerCase()).toContain("nineteen");
    expect(buildProductCatalogSpeech().toLowerCase()).toMatch(/urban|spanish|global/);
  });

  it("gates live transfer on office hours and call duration", () => {
    const early = canTransferToLiveAgent({
      callStartedAtMs: Date.now(),
      transferNumberConfigured: true,
    });
    expect(early.allowed).toBe(false);

    const ready = canTransferToLiveAgent({
      callStartedAtMs: Date.now() - OFFICE_HOURS.minCallDurationMsForTransfer - 1_000,
      transferNumberConfigured: true,
    });
    expect(typeof ready.allowed).toBe("boolean");
    expect(ready.reasonSpoken.length).toBeGreaterThan(10);
  });
});

describe("catalog", () => {
  it("falls back to baseline when WordPress has no matching categories", () => {
    const catalog = buildCatalog({ wpCategories: [{ id: 1, name: "Sports", count: 3 }] });
    expect(catalog.categories).toEqual(["Urban", "Spanish", "Global"]);
    expect(catalog.plans[0]?.priceUsd).toBe(19.99);
  });

  it("parses live plan prices from CMS text when present", () => {
    const plans = parsePlansFromCmsText(
      "1 Month plan $19.99 · 3 Months $53.97 · 6 Months $95.94 · 12 Months $179.88",
    );
    expect(plans?.[0]?.priceUsd).toBe(19.99);
    expect(plans?.[3]?.priceUsd).toBe(179.88);
  });

  it("normalizes package types from speech", () => {
    expect(normalizePackageType("bundle of two")).toBe("Bundle of Two");
    expect(normalizePackageType("single")).toBe("Single Edition");
    expect(normalizePackageType("three")).toBe("Bundle of Three");
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

  it("PlaceOrder redirects to the checkout-link flow without inmate fields", async () => {
    const result = await executeMailCallTool(
      "PlaceOrder",
      JSON.stringify({ note: "caller wants to order" }),
      { callSid: "t2", callStartedAtMs: Date.now() },
    );
    expect(result.toolPayload.ok).toBe(false);
    expect(result.toolPayload.reason).toBe("use_checkout_link");
    expect(result.spokenHint?.toLowerCase()).toMatch(/checkout link|urban|spanish|global/);
    expect(result.spokenHint).not.toMatch(/inmate name|facility address/i);
  });

  it("send_checkout_link requires fields then confirms after Resend success", async () => {
    const incomplete = await executeMailCallTool(
      "send_checkout_link",
      JSON.stringify({ contact_email: "mary@example.com" }),
      { callSid: "esc-1", callStartedAtMs: Date.now() },
    );
    expect(incomplete.toolPayload.ok).toBe(false);
    expect(incomplete.spokenHint?.toLowerCase()).toMatch(/urban|plan|package|email/);
  });

  it("requires the privacy-safe checkout-link schema", () => {
    const definition = MAILCALL_TOOL_DEFINITIONS.find(
      (tool) => tool.type === "function" && tool.function.name === "send_checkout_link",
    );
    const required = (definition?.function.parameters as { required?: string[] })?.required;
    expect(required).toEqual([
      "contact_email",
      "newspaper_selection",
      "plan_duration",
      "package_type",
    ]);
    expect(required).not.toContain("inmate_name");
    expect(required).not.toContain("facility_address");
  });

  it("builds an escaped checkout-link HTML email", () => {
    const html = buildCheckoutLinkHtml({
      contactEmail: "mary@example.com",
      newspaperSelection: "Urban",
      planDuration: 3,
      packageType: "Single Edition",
      checkoutUrl: "https://mailcallnewspaper.com/register",
      callSid: "CA123",
    });
    expect(html).toContain("Your MailCall Checkout Link");
    expect(html).toContain("Urban edition");
    expect(html).toContain("Single Edition");
    expect(html).toContain("https://mailcallnewspaper.com/register");
    expect(html).toContain("Open Secure Checkout");
  });

  it("builds a privacy-safe support note HTML table", () => {
    const html = buildSupportEscalationHtml({
      senderName: "Mary <Smith>",
      senderEmail: "mary@example.com",
      senderPhone: "2125550198",
      issueSummary: "Delivery delay",
      callSid: "CA123",
    });
    expect(html).toContain("MailCall Support Note");
    expect(html).toContain("Mary &lt;Smith&gt;");
    expect(html).not.toContain("Mary <Smith>");
    expect(html).not.toMatch(/inmate/i);
  });
});
