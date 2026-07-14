import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  aggregateOrderForCaller,
  printOrderAggregationChecklist,
} from "../src/adapters/orderAggregationEngine.js";
import { phoneNumbersMatch } from "../src/utils/phoneNormalizer.js";

vi.mock("../src/services/shopifyService.js", () => ({
  lookupOrderStatus: vi.fn(),
}));

vi.mock("../src/adapters/shopifyStorefrontAdapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/adapters/shopifyStorefrontAdapter.js")>();
  return {
    ...actual,
    getCustomerHistory: vi.fn(),
  };
});

import { lookupOrderStatus } from "../src/services/shopifyService.js";
import { getCustomerHistory } from "../src/adapters/shopifyStorefrontAdapter.js";

describe("phoneNumbersMatch country-code normalization", () => {
  it("matches formatted US numbers with and without +1", () => {
    expect(phoneNumbersMatch("+1 (555) 123-4567", "5551234567")).toBe(true);
    expect(phoneNumbersMatch("0015551234567", "555-123-4567")).toBe(true);
  });

  it("rejects mismatched numbers", () => {
    expect(phoneNumbersMatch("+15551234567", "+15559876543")).toBe(false);
    expect(phoneNumbersMatch("anonymous", "+15551234567")).toBe(false);
  });
});

describe("aggregateOrderForCaller", () => {
  let logs: string[];
  let originalLog: typeof console.log;

  beforeEach(() => {
    logs = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    vi.mocked(lookupOrderStatus).mockReset();
    vi.mocked(getCustomerHistory).mockReset();
  });

  afterEach(() => {
    console.log = originalLog;
  });

  it("returns verified OrderView with shipping and history unlocked", async () => {
    vi.mocked(lookupOrderStatus).mockResolvedValue({
      status: "found",
      orderNumber: "#48011",
      customerPhone: "+1 555-123-4567",
      shippingPhone: "5551234567",
      shippingAddress: "123 Main St, Austin TX",
      customerId: "gid://shopify/Customer/99",
      tags: ["Mail order", "VIP"],
      events: ["Staff note: packed", "Email notification sent ChristianSweeten_147455.pdf"],
      orderNote: "Leave at door",
      metafields: [{ namespace: "custom", key: "productname", value: "Healing Mag" }],
      orderMetafields: {
        productName: "Healing Mag",
        endDate: null,
        magazineStartDate: null,
      },
      timelineAttachments: [
        { fileName: "ChristianSweeten_147455.pdf", timestamp: null },
      ],
      shippingFee: "$0.00",
      totalTax: "$1.00",
      subtotalAmount: "$12.00",
      subtotalPrice: "$12.00",
      paymentMethod: "shopify_payments",
      fulfillmentStatus: "FULFILLED",
      lineItems: [{ title: "Healing Book", quantity: 1, sku: "HB-1", price: "12.00" }],
    });
    vi.mocked(getCustomerHistory).mockResolvedValue({
      status: "found",
      customerId: "gid://shopify/Customer/99",
      orderCount: 3,
      orders: [
        {
          orderNumber: "#100",
          monthYear: "June 2025",
          totalAmount: "20.00 USD",
          status: "fulfilled",
          items: "Book A",
        },
      ],
    });

    const result = await aggregateOrderForCaller("48011", "555-123-4567", "CA_AGG_V");

    expect(result.status).toBe("found");
    expect(result.is_verified_caller).toBe(true);
    expect(result.orderView?.shipping_address).toMatch(/123 Main St/);
    expect(result.orderView?.past_order_history).toHaveLength(1);
    expect(result.orderView?.order_metafields?.productName).toBe("Healing Mag");
    expect(result.orderView?.timeline_attachments?.[0]?.fileName).toBe(
      "ChristianSweeten_147455.pdf",
    );
    expect(result.orderView?.shipping_fee).toBe("$0.00");
    expect(result.orderView?.payment_method).toBe("shopify_payments");
    expect(logs.some((l) => l.includes("[SYSTEM START] Fetching Order"))).toBe(true);
    expect(logs.some((l) => l.includes("[SUCCESS] Core Order Data retrieved"))).toBe(true);
    expect(logs.some((l) => l.includes("Status: VERIFIED"))).toBe(true);
    expect(logs.some((l) => l.includes("Full access granted"))).toBe(true);
    expect(logs.some((l) => l.includes("[WARN] Metafields empty"))).toBe(false);
    expect(logs.some((l) => l.includes("Metafields queried"))).toBe(true);
  });

  it("redacts shipping/history for unverified callers but keeps metafields/timeline", async () => {
    vi.mocked(lookupOrderStatus).mockResolvedValue({
      status: "found",
      orderNumber: "#48011",
      customerPhone: "+15551234567",
      shippingAddress: "123 Main St, Austin TX",
      customerId: "gid://shopify/Customer/99",
      tags: ["Mail order"],
      events: ["Refund notification sent"],
      orderNote: "Account deposit",
      metafields: [],
      orderMetafields: { productName: null, endDate: null, magazineStartDate: null },
      timelineAttachments: [],
      fulfillmentStatus: "FULFILLED",
    });
    vi.mocked(getCustomerHistory).mockResolvedValue({
      status: "found",
      orderCount: 2,
      orders: [
        {
          orderNumber: "#99",
          monthYear: "May 2025",
          totalAmount: "10.00 USD",
          status: "fulfilled",
          items: "Book B",
        },
      ],
    });

    const result = await aggregateOrderForCaller("48011", "+15550001111", "CA_AGG_U");

    expect(result.is_verified_caller).toBe(false);
    expect(result.orderView?.shipping_address).toBeUndefined();
    expect(result.orderView?.past_order_history).toBeUndefined();
    expect(result.orderView?.events).toEqual(["Refund notification sent"]);
    expect(logs.some((l) => l.includes("Status: UNVERIFIED"))).toBe(true);
    expect(logs.some((l) => l.includes("shipping_address and past_order_history redacted"))).toBe(
      true,
    );
    expect(logs.some((l) => l.includes("[WARN] Metafields empty"))).toBe(false);
  });

  it("prints fail diagnostics when order is not found", async () => {
    vi.mocked(lookupOrderStatus).mockResolvedValue({
      status: "not_found",
      searchedNumber: "#99999",
      error: "No exact match found in Shopify.",
    });

    const result = await aggregateOrderForCaller("99999", "+15551234567", "CA_MISS");
    expect(result.status).toBe("not_found");
    expect(result.orderView).toBeNull();
    expect(logs.some((l) => l.includes("[FAIL] Core Order Data missing"))).toBe(true);
  });
});

describe("printOrderAggregationChecklist", () => {
  it("emits the required checklist lines", () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      printOrderAggregationChecklist("#48011", {
        coreOrder: true,
        tags: true,
        tagList: ["Mail order"],
        timeline: true,
        timelineEventCount: 4,
        metafields: true,
        metafieldCount: 1,
        metafieldQueryFailed: false,
        customerHistory: true,
        pastOrderCount: 2,
        verified: true,
        callerPhoneLast4: "***7890",
        payloadAccess: "full",
        timelineAttachmentCount: 1,
      });
    } finally {
      console.log = original;
    }

    expect(lines[0]).toBe("[SYSTEM START] Fetching Order #48011...");
    expect(lines.some((l) => l.includes("Found 4 comments/notes"))).toBe(true);
    expect(lines.some((l) => l.includes("MATCHES Order Phone"))).toBe(true);
    expect(lines.some((l) => l.includes("Metafields queried"))).toBe(true);
    expect(lines.some((l) => l.includes("Timeline attachments detected"))).toBe(true);
  });
});
