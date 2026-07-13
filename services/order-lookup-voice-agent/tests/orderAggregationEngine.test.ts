import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  aggregateOrderForCaller,
  printOrderAggregationChecklist,
} from "../src/adapters/orderAggregationEngine.js";
import { phoneNumbersMatch } from "../src/utils/phoneNormalizer.js";
import { buildActiveOrderContextPayload } from "../src/adapters/llmToolExecutor.js";

vi.mock("../src/adapters/shopifyStorefrontAdapter.js", () => ({
  getOrderStatus: vi.fn(),
  getCustomerHistory: vi.fn(),
}));

import {
  getOrderStatus,
  getCustomerHistory,
} from "../src/adapters/shopifyStorefrontAdapter.js";

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
    vi.mocked(getOrderStatus).mockReset();
    vi.mocked(getCustomerHistory).mockReset();
  });

  afterEach(() => {
    console.log = originalLog;
  });

  it("returns full payload for verified callers including history and shipping", async () => {
    vi.mocked(getOrderStatus).mockResolvedValue({
      status: "found",
      orderNumber: "#48011",
      customerPhone: "+1 555-123-4567",
      shippingPhone: "5551234567",
      shippingAddress: "123 Main St, Austin TX",
      customerId: "gid://shopify/Customer/99",
      tags: ["Mail order", "VIP"],
      events: ["Staff note: packed", "Email notification sent"],
      orderNote: "Leave at door",
      metafields: [{ namespace: "custom", key: "route", value: "west" }],
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
    expect(result.shipping_address).toMatch(/123 Main St/);
    expect(result.past_order_history).toHaveLength(1);
    expect(result.order?.tags).toEqual(["Mail order", "VIP"]);
    expect(result.order?.events).toHaveLength(2);
    expect(result.order?.metafields?.[0]?.key).toBe("route");
    expect(logs.some((l) => l.includes("[SYSTEM START] Fetching Order"))).toBe(true);
    expect(logs.some((l) => l.includes("[SUCCESS] Core Order Data retrieved"))).toBe(true);
    expect(logs.some((l) => l.includes("Status: VERIFIED"))).toBe(true);
    expect(logs.some((l) => l.includes("Full access granted"))).toBe(true);
  });

  it("redacts shipping and past history for unverified callers but keeps timeline/tags/notes", async () => {
    vi.mocked(getOrderStatus).mockResolvedValue({
      status: "found",
      orderNumber: "#48011",
      customerPhone: "+15551234567",
      shippingAddress: "123 Main St, Austin TX",
      customerId: "gid://shopify/Customer/99",
      tags: ["Mail order"],
      events: ["Refund notification sent"],
      orderNote: "Account deposit",
      metafields: [],
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
    expect(result.shipping_address).toBeNull();
    expect(result.past_order_history).toBeNull();
    expect(result.order?.shippingAddress).toBeUndefined();
    expect(result.order?.pastOrderHistory).toBeUndefined();
    expect(result.order?.events).toEqual(["Refund notification sent"]);
    expect(result.order?.tags).toEqual(["Mail order"]);
    expect(result.order?.orderNote).toBe("Account deposit");
    expect(logs.some((l) => l.includes("Status: UNVERIFIED"))).toBe(true);
    expect(logs.some((l) => l.includes("shipping_address and past_order_history redacted"))).toBe(
      true,
    );

    const shaped = buildActiveOrderContextPayload(result.order!, {
      isVerifiedCaller: false,
    } as import("../src/types/order.js").CallSession);
    expect(shaped.shipping_address).toBeNull();
    expect(shaped.past_order_history).toBeNull();
    expect(shaped.events).toEqual(["Refund notification sent"]);
    expect(shaped.tags).toEqual(["Mail order"]);
    expect(shaped.note).toBe("Account deposit");
  });

  it("prints fail diagnostics when order is not found", async () => {
    vi.mocked(getOrderStatus).mockResolvedValue({
      status: "not_found",
      searchedNumber: "#99999",
      error: "No exact match found in Shopify.",
    });

    const result = await aggregateOrderForCaller("99999", "+15551234567", "CA_MISS");
    expect(result.status).toBe("not_found");
    expect(result.order).toBeNull();
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
        customerHistory: true,
        pastOrderCount: 2,
        verified: true,
        callerPhone: "+1234567890",
        payloadAccess: "full",
      });
    } finally {
      console.log = original;
    }

    expect(lines[0]).toBe("[SYSTEM START] Fetching Order #48011...");
    expect(lines.some((l) => l.includes("Found 4 comments/notes"))).toBe(true);
    expect(lines.some((l) => l.includes("MATCHES Order Phone"))).toBe(true);
  });
});
