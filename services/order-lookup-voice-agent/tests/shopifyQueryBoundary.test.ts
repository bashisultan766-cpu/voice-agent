import { describe, expect, it, vi } from "vitest";

vi.mock("../src/infra/shopifyHttpClient.js", () => ({
  shopifyGraphql: vi.fn(async () => ({
    nodes: [
      { id: "gid://shopify/ProductVariant/1", inventoryQuantity: 4 },
      { id: "gid://shopify/ProductVariant/2", inventoryQuantity: 0 },
    ],
    order: {
      events: {
        nodes: [
          { message: "Staff Alice packed the order", createdAt: "2026-01-01T00:00:00Z" },
          { message: "Label created", createdAt: "2026-01-02T00:00:00Z" },
        ],
      },
    },
  })),
  shopifyRestJson: vi.fn(async () => ({ ok: true, data: { events: [] } })),
}));

vi.mock("../src/adapters/shopifyStorefrontAdapter.js", () => ({
  searchByISBN: vi.fn(async () => ({
    status: "found",
    bookName: "Test Book",
    variantId: "gid://shopify/ProductVariant/9",
    price: "12.00",
    isbn: "9780000000000",
    inStock: true,
  })),
  searchByTitle: vi.fn(async () => ({
    status: "found",
    bookName: "Title Book",
    variantId: "gid://shopify/ProductVariant/8",
    price: "9.00",
    inStock: true,
  })),
}));

vi.mock("../src/services/shopifyService.js", () => ({
  lookupOrderStatus: vi.fn(),
}));

import {
  fetchInventoryView,
  fetchOrderTimelineView,
  searchProductsView,
} from "../src/infra/shopifyQueryBoundary.js";

describe("ShopifyQueryBoundary DTOs", () => {
  it("returns InventoryView without raw Shopify payload keys", async () => {
    const views = await fetchInventoryView([
      "gid://shopify/ProductVariant/1",
      "gid://shopify/ProductVariant/2",
    ]);
    expect(views).toEqual([
      { variantId: "gid://shopify/ProductVariant/1", available: 4 },
      { variantId: "gid://shopify/ProductVariant/2", available: 0 },
    ]);
    expect(JSON.stringify(views)).not.toContain("admin_graphql_api_id");
    expect(JSON.stringify(views)).not.toContain("inventoryQuantity");
  });

  it("returns OrderTimelineView with redacted staff summaries", async () => {
    const view = await fetchOrderTimelineView("gid://shopify/Order/123");
    expect(view.events.length).toBeGreaterThan(0);
    expect(JSON.stringify(view)).not.toContain("admin_graphql_api_id");
    expect(JSON.stringify(view)).not.toMatch(/Staff Alice/);
  });

  it("returns ProductSearchView DTOs only", async () => {
    const views = await searchProductsView("9780000000000", "CA_TEST", "isbn");
    expect(views[0]).toMatchObject({
      title: "Test Book",
      variantId: "gid://shopify/ProductVariant/9",
      available: true,
    });
    expect(JSON.stringify(views)).not.toContain("admin_graphql_api_id");
  });
});
