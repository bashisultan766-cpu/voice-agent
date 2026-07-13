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
import { transactionNodesFromConnection } from "../utils/orderDataParser.js";

const ORDER_DEEP_BY_ID_QUERY = `query OrderDeepById($id: ID!) {
  order(id: $id) {
    note
    tags
    sourceName
    publication {
      name
    }
    customAttributes {
      key
      value
    }
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
    transactions(first: 40) {
      id
      kind
      status
      gateway
      formattedGateway
      processedAt
      accountNumber
      manualPaymentGateway
      receiptJson
      paymentDetails {
        ... on CardPaymentDetails {
          company
          number
        }
      }
      amountSet {
        shopMoney {
          amount
          currencyCode
        }
      }
    }
    metafields(first: 20) {
      edges {
        node {
          namespace
          key
          value
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
  return (nodes ?? [])
    .filter((node): node is NonNullable<typeof node> => Boolean(node?.message?.trim()))
    .map((node) => {
      const authorName = node.authorName ?? node.staffName ?? null;
      return {
        message: node.message,
        action: node.action,
        createdAt: node.createdAt,
        authorName,
        staffName: authorName,
      };
    });
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

async function fetchDeepOrderByGid(
  orderGid: string,
): Promise<{
  events: OrderTimelineEvent[];
  transactions: DeepOrderGraphqlNode["transactions"];
  patch: Partial<DeepOrderGraphqlNode>;
}> {
  const data = await shopifyGraphql<{
    order?: DeepOrderGraphqlNode;
  }>(ORDER_DEEP_BY_ID_QUERY, { id: orderGid });

  const order = data.order;
  const fromNodes = normalizeTimelineNodes(order?.events?.nodes);
  const fromEdges = normalizeTimelineNodes(
    (order?.events?.edges ?? []).map((edge) => edge.node),
  );
  const events = fromNodes.length ? fromNodes : fromEdges;

  return {
    events,
    transactions: order?.transactions,
    patch: {
      note: order?.note,
      tags: order?.tags,
      sourceName: order?.sourceName,
      publication: order?.publication,
      channelInformation: order?.channelInformation,
      customAttributes: order?.customAttributes,
      metafields: order?.metafields,
    },
  };
}

async function fetchTimelineGraphqlByOrderGid(
  orderGid: string,
): Promise<OrderTimelineEvent[]> {
  const deep = await fetchDeepOrderByGid(orderGid);
  return deep.events;
}

async function fetchTimelineRestByNumericId(
  numericId: string,
): Promise<OrderTimelineEvent[]> {
  const cfg = getConfig();
  const accessToken = cfg.SHOPIFY_ADMIN_ACCESS_TOKEN;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.SHOPIFY_TIMEOUT_MS);

  try {
    const res = await fetch(`${shopifyRestBaseUrl()}/orders/${numericId}/events.json`, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": accessToken,
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
 * Always deep-fetch by order GID after a search match.
 * Search edges are identity only — full timeline/transactions come from GraphQL deep lookup.
 */
export async function enrichOrderNodeTimeline(
  node: DeepOrderGraphqlNode,
): Promise<DeepOrderGraphqlNode> {
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
    const deep = await fetchDeepOrderByGid(orderGid);
    let enriched: DeepOrderGraphqlNode = {
      ...node,
      note: deep.patch.note ?? node.note,
      tags: deep.patch.tags ?? node.tags,
      sourceName: deep.patch.sourceName ?? node.sourceName,
      publication: deep.patch.publication ?? node.publication,
      channelInformation: deep.patch.channelInformation ?? node.channelInformation,
      customAttributes: deep.patch.customAttributes ?? node.customAttributes,
      metafields: deep.patch.metafields ?? node.metafields,
    };

    if (deep.events.length) {
      logger.info("shopify_timeline_enriched", {
        orderNumber: node.name,
        source: "graphql_order_by_id",
        eventCount: deep.events.length,
      });
      enriched = { ...enriched, events: toTimelineEdges(deep.events) };
    }

    if (deep.transactions) {
      const txCount = transactionNodesFromConnection(deep.transactions).length;
      if (txCount > 0) {
        logger.info("shopify_transactions_enriched", {
          orderNumber: node.name,
          source: "graphql_order_by_id",
          transactionCount: txCount,
        });
        enriched = { ...enriched, transactions: deep.transactions };
      }
    }

    if (
      timelineEventCount(enriched) > 0 ||
      transactionNodesFromConnection(enriched.transactions).length > 0
    ) {
      return enriched;
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
