/**
 * Read-only Shopify GraphQL boundary. No business or disclosure policy lives here.
 * Logistics sidecar traffic is delegated to `logisticsPolicyClient` — this file
 * never opens a socket to LOGISTICS_INTELLIGENCE_URL.
 */
import { lookupOrderStatus } from "../services/shopifyService.js";
import { searchByISBN, searchByTitle } from "../adapters/shopifyStorefrontAdapter.js";
import { shopifyGraphql, shopifyRestJson } from "./shopifyHttpClient.js";
import type { InventoryView, OrderTimelineView, ProductSearchView } from "./shopifyViews.js";
import { logger } from "../utils/logger.js";

export { lookupOrderStatus, searchByISBN, searchByTitle };
export type { InventoryView, OrderTimelineView, ProductSearchView };

const VARIANT_INVENTORY_QUERY = `
  query VariantInventory($ids: [ID!]!) {
    nodes(ids: $ids) { ... on ProductVariant { id inventoryQuantity } }
  }
`;

const ORDER_TIMELINE_QUERY = `query OrderTimelineById($id: ID!) {
  order(id: $id) {
    events(first: 100) {
      nodes {
        __typename
        ... on BasicEvent { message createdAt }
        ... on CommentEvent { message createdAt }
      }
      edges {
        node {
          __typename
          ... on BasicEvent { message createdAt }
          ... on CommentEvent { message createdAt }
        }
      }
    }
  }
}`;

function toOrderGid(orderIdOrGid: string): string {
  const trimmed = orderIdOrGid.trim();
  if (trimmed.startsWith("gid://")) return trimmed;
  return `gid://shopify/Order/${trimmed.replace(/\D/g, "")}`;
}

function orderGidToNumericId(gid: string): string | undefined {
  const match = gid.match(/\/Order\/(\d+)\s*$/);
  return match?.[1];
}

function redactStaff(summary: string): string {
  return summary
    .replace(/\b(?:staff|employee|agent)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/gi, "staff member")
    .trim();
}

/**
 * Returns only availability values, never Shopify graph nodes.
 * Inventory is answered from Admin GraphQL only — logistics sidecar reads live in
 * `logisticsPolicyClient` so ShopifyQueryBoundary is not the eligibility owner.
 */
export async function fetchInventoryView(variantIds: string[]): Promise<InventoryView[]> {
  const ids = [...new Set(variantIds.map((id) => id.trim()).filter(
    (id) => id.startsWith("gid://shopify/ProductVariant/"),
  ))];
  if (!ids.length) return [];

  try {
    const data = await shopifyGraphql<{
      nodes: Array<{ id?: string; inventoryQuantity?: number | null } | null>;
    }>(VARIANT_INVENTORY_QUERY, { ids });
    return ids.map((variantId) => {
      const node = data.nodes?.find((candidate) => candidate?.id === variantId);
      return {
        variantId,
        available: node?.inventoryQuantity == null ? null : Math.max(0, Math.floor(node.inventoryQuantity)),
      };
    });
  } catch {
    return ids.map((variantId) => ({ variantId, available: null, unavailable: true }));
  }
}

/** Timeline DTO — summaries only; staff names redacted when present. */
export async function fetchOrderTimelineView(orderIdOrGid: string): Promise<OrderTimelineView> {
  const orderGid = toOrderGid(orderIdOrGid);
  const events: OrderTimelineView["events"] = [];

  try {
    const data = await shopifyGraphql<{
      order?: {
        events?: {
          nodes?: Array<{ message?: string; createdAt?: string } | null>;
          edges?: Array<{ node?: { message?: string; createdAt?: string } | null }>;
        };
      };
    }>(ORDER_TIMELINE_QUERY, { id: orderGid });

    const nodes = data.order?.events?.nodes?.length
      ? data.order.events.nodes
      : (data.order?.events?.edges ?? []).map((edge) => edge.node);
    for (const node of nodes ?? []) {
      const summary = redactStaff((node?.message ?? "").trim());
      if (!summary) continue;
      events.push({ summary, at: node?.createdAt });
    }
  } catch (err) {
    logger.warn("shopify_timeline_view_graphql_failed", {
      orderGid,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!events.length) {
    const numericId = orderGidToNumericId(orderGid);
    if (numericId) {
      const rest = await shopifyRestJson<{
        events?: Array<{ message?: string; description?: string; body?: string; created_at?: string }>;
      }>(`/orders/${numericId}/events.json`);
      if (rest.ok) {
        for (const event of rest.data.events ?? []) {
          const summary = redactStaff(
            (event.message ?? event.description ?? event.body ?? "").trim(),
          );
          if (!summary) continue;
          events.push({ summary, at: event.created_at });
        }
      }
    }
  }

  return { events };
}

/** Adapter results are mapped to a stable conversational product DTO. */
export async function searchProductsView(
  query: string,
  callSid: string,
  kind: "isbn" | "title" = "title",
): Promise<ProductSearchView[]> {
  const result = kind === "isbn" ? await searchByISBN(query, callSid) : await searchByTitle(query, callSid);
  if (result.status !== "found" || !result.variantId || !result.bookName) return [];
  return [{
    title: result.bookName,
    variantId: result.variantId,
    price: result.price,
    isbn: result.isbn,
    available: result.inStock !== false,
  }];
}
