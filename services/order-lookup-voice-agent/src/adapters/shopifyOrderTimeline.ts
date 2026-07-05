/**
 * Shopify order timeline enrichment — search queries often return events: [].
 * Fallback: direct order(id:) GraphQL + REST /orders/{id}/events.json.
 */
import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { maskShopifyToken } from "../utils/security.js";
import { ShopifyAuthError } from "../platform/shopifyErrors.js";
import { shopifyGraphql } from "../tools/shopifyLiveSearch.js";
import type { OrderTimelineEvent } from "./orderFieldExtractors.js";
import type { DeepOrderGraphqlNode } from "../utils/orderDataParser.js";

const ORDER_TIMELINE_BY_ID_QUERY = `query OrderTimelineById($id: ID!) {
  order(id: $id) {
    events(first: 100) {
      nodes {
        __typename
        ... on BasicEvent {
          message
          action
          createdAt
        }
        ... on CommentEvent {
          message
          createdAt
        }
      }
      edges {
        node {
          __typename
          ... on BasicEvent {
            message
            action
            createdAt
          }
          ... on CommentEvent {
            message
            createdAt
          }
        }
      }
    }
  }
}`;

interface RestShopifyEvent {
  verb?: string;
  message?: string;
  description?: string;
  body?: string;
  created_at?: string;
}

function shopifyRestBaseUrl(): string {
  const cfg = getConfig();
  const domain = cfg.SHOPIFY_SHOP_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `https://${domain}/admin/api/${cfg.SHOPIFY_API_VERSION}`;
}

/** Extract numeric Shopify order id from Admin GraphQL gid. */
export function orderGidToNumericId(gid: string | undefined): string | undefined {
  if (!gid?.trim()) return undefined;
  const match = gid.trim().match(/\/Order\/(\d+)\s*$/);
  return match?.[1];
}

function timelineEventCount(node: DeepOrderGraphqlNode): number {
  return node.events?.edges?.length ?? 0;
}

function toTimelineEdges(
  events: OrderTimelineEvent[],
): DeepOrderGraphqlNode["events"] {
  return {
    edges: events.map((event) => ({ node: event })),
  };
}

function normalizeTimelineNodes(
  nodes: Array<OrderTimelineEvent | null | undefined> | undefined,
): OrderTimelineEvent[] {
  return (nodes ?? []).filter((node): node is OrderTimelineEvent => Boolean(node?.message?.trim()));
}

function messagesFromRestEvents(events: RestShopifyEvent[]): OrderTimelineEvent[] {
  const out: OrderTimelineEvent[] = [];
  for (const event of events) {
    const message = (event.message ?? event.description ?? event.body ?? "").trim();
    if (!message) continue;
    out.push({
      message,
      action: event.verb ?? undefined,
      createdAt: event.created_at ?? undefined,
    });
  }
  return out;
}

async function fetchTimelineGraphqlByOrderGid(
  orderGid: string,
): Promise<OrderTimelineEvent[]> {
  const data = await shopifyGraphql<{
    order?: {
      events?: {
        nodes?: OrderTimelineEvent[];
        edges?: Array<{ node?: OrderTimelineEvent }>;
      };
    };
  }>(ORDER_TIMELINE_BY_ID_QUERY, { id: orderGid });

  const fromNodes = normalizeTimelineNodes(data.order?.events?.nodes);
  if (fromNodes.length) return fromNodes;

  const fromEdges = (data.order?.events?.edges ?? [])
    .map((edge) => edge.node)
    .filter((node): node is OrderTimelineEvent => Boolean(node?.message?.trim()));
  return fromEdges;
}

async function fetchTimelineRestByNumericId(
  numericId: string,
): Promise<OrderTimelineEvent[]> {
  const cfg = getConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.SHOPIFY_TIMEOUT_MS);

  try {
    const res = await fetch(`${shopifyRestBaseUrl()}/orders/${numericId}/events.json`, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": cfg.SHOPIFY_ADMIN_ACCESS_TOKEN,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new ShopifyAuthError(res.status);
      }
      logger.warn("shopify_rest_order_events_failed", {
        orderId: numericId,
        httpStatus: res.status,
      });
      return [];
    }

    const body = (await res.json()) as { events?: RestShopifyEvent[] };
    return messagesFromRestEvents(body.events ?? []);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Enrich order node with timeline when the list/search query returned zero events.
 */
export async function enrichOrderNodeTimeline(
  node: DeepOrderGraphqlNode,
): Promise<DeepOrderGraphqlNode> {
  if (timelineEventCount(node) > 0) {
    return node;
  }

  const orderGid = node.id;
  const numericId = orderGidToNumericId(orderGid);

  if (!orderGid) {
    logger.warn("shopify_timeline_enrichment_skipped", {
      orderNumber: node.name,
      reason: "missing_order_gid",
    });
    return node;
  }

  try {
    const gqlEvents = await fetchTimelineGraphqlByOrderGid(orderGid);
    if (gqlEvents.length) {
      logger.info("shopify_timeline_enriched", {
        orderNumber: node.name,
        source: "graphql_order_by_id",
        eventCount: gqlEvents.length,
      });
      return { ...node, events: toTimelineEdges(gqlEvents) };
    }
  } catch (err) {
    logger.warn("shopify_timeline_graphql_by_id_failed", {
      orderNumber: node.name,
      orderGid,
      error: err instanceof Error ? err.message : String(err),
      token: maskShopifyToken(getConfig().SHOPIFY_ADMIN_ACCESS_TOKEN),
    });
  }

  if (numericId) {
    try {
      const restEvents = await fetchTimelineRestByNumericId(numericId);
      if (restEvents.length) {
        logger.info("shopify_timeline_enriched", {
          orderNumber: node.name,
          source: "rest_order_events",
          eventCount: restEvents.length,
        });
        return { ...node, events: toTimelineEdges(restEvents) };
      }
    } catch (err) {
      logger.warn("shopify_timeline_rest_failed", {
        orderNumber: node.name,
        orderId: numericId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.warn("shopify_timeline_enrichment_empty", {
    orderNumber: node.name,
    orderGid,
    orderId: numericId,
    note: "No timeline events from search, GraphQL by id, or REST — refund notification email may be unavailable via API",
  });

  return node;
}
