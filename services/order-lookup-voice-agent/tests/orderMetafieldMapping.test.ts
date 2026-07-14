import { describe, expect, it } from "vitest";
import {
  compileOrderMetafieldBundle,
  extractTimelineAttachments,
  flattenMetafieldNodes,
  resolvePaymentMethod,
} from "../src/adapters/orderMetafieldMapping.js";

describe("orderMetafieldMapping", () => {
  it("flattens identifiers list and connection edges", () => {
    const fromList = flattenMetafieldNodes([
      { namespace: "custom", key: "productname", value: "Magazine A" },
      null,
    ]);
    expect(fromList).toEqual([
      { namespace: "custom", key: "productname", value: "Magazine A" },
    ]);

    const fromEdges = flattenMetafieldNodes({
      edges: [{ node: { namespace: "global", key: "enddate", value: "2026-12-01" } }],
    });
    expect(fromEdges[0]?.key).toBe("enddate");
  });

  it("compiles productname / enddate / magazinestartdate bundle", () => {
    const bundle = compileOrderMetafieldBundle([
      { namespace: "global", key: "productname", value: "Global Name" },
      { namespace: "custom", key: "productname", value: "Custom Name" },
      { namespace: "custom", key: "enddate", value: "2027-01-01" },
      { namespace: "custom", key: "magazinestartdate", value: "2026-01-01" },
    ]);
    expect(bundle.productName).toBe("Custom Name");
    expect(bundle.endDate).toBe("2027-01-01");
    expect(bundle.magazineStartDate).toBe("2026-01-01");
  });

  it("extracts PDF / image attachments from timeline messages", () => {
    const attachments = extractTimelineAttachments([
      {
        message: "Attached ChristianSweeten_147455.pdf for the customer",
        createdAt: "2026-05-01T12:00:00Z",
      },
      { message: "Also see photo.jpg in files", createdAt: null },
      { message: "duplicate ChristianSweeten_147455.pdf again", createdAt: "x" },
    ]);
    expect(attachments).toEqual([
      { fileName: "ChristianSweeten_147455.pdf", timestamp: "2026-05-01T12:00:00Z" },
      { fileName: "photo.jpg", timestamp: null },
    ]);
  });

  it("resolves payment method from gateway names", () => {
    expect(resolvePaymentMethod(["paypal", "shopify_payments"], undefined)).toBe(
      "paypal, shopify_payments",
    );
    expect(resolvePaymentMethod([], "Visa")).toBe("Visa");
    expect(resolvePaymentMethod(undefined, undefined)).toBeNull();
  });
});
