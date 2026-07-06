/**
 * READ-ONLY Shopify Admin API audit — order PII / payment / fulfillment depth check.
 * Does NOT import or modify live agent code.
 *
 * Usage (from services/order-lookup-voice-agent):
 *   npx tsx scripts/audit_shopify_order_payload.ts
 *   npx tsx scripts/audit_shopify_order_payload.ts "#48065"
 */
import { config as loadEnv } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serviceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: join(serviceRoot, ".env") });

const SHOP = (process.env.SHOPIFY_SHOP_DOMAIN ?? "").trim();
const TOKEN = (process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ?? "").trim();
const API_VERSION = (process.env.SHOPIFY_API_VERSION ?? "2024-01").trim();
const ORDER_NAME = (process.argv[2] ?? "#48065").trim();
const TIMEOUT_MS = Number(process.env.SHOPIFY_TIMEOUT_MS ?? 30_000);

if (!SHOP || !TOKEN) {
  console.error(
    "Missing SHOPIFY_SHOP_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN in .env",
  );
  process.exit(1);
}

const AUDIT_ORDER_QUERY = `query AuditOrderPayload($query: String!, $first: Int!) {
  orders(first: $first, query: $query) {
    edges {
      node {
        id
        name
        createdAt
        processedAt
        updatedAt
        email
        phone
        note
        displayFulfillmentStatus
        displayFinancialStatus
        cancelledAt
        cancelReason
        confirmed
        currencyCode
        subtotalPriceSet {
          shopMoney { amount currencyCode }
        }
        totalShippingPriceSet {
          shopMoney { amount currencyCode }
        }
        totalTaxSet {
          shopMoney { amount currencyCode }
        }
        totalPriceSet {
          shopMoney { amount currencyCode }
        }
        totalRefundedSet {
          shopMoney { amount currencyCode }
        }
        paymentGatewayNames
        shippingAddress {
          name
          company
          address1
          address2
          city
          province
          provinceCode
          zip
          country
          countryCodeV2
          phone
        }
        billingAddress {
          name
          company
          address1
          address2
          city
          province
          provinceCode
          zip
          country
          countryCodeV2
          phone
        }
        customer {
          id
          firstName
          lastName
          email
          phone
          numberOfOrders
          tags
          orders(first: 10, sortKey: CREATED_AT, reverse: true) {
            edges {
              node {
                id
                name
                createdAt
                displayFulfillmentStatus
                displayFinancialStatus
                totalPriceSet {
                  shopMoney { amount currencyCode }
                }
                lineItems(first: 5) {
                  edges {
                    node {
                      title
                      quantity
                    }
                  }
                }
              }
            }
          }
        }
        lineItems(first: 25) {
          edges {
            node {
              title
              quantity
              sku
              variantTitle
              originalUnitPriceSet {
                shopMoney { amount currencyCode }
              }
            }
          }
        }
        fulfillments(first: 10) {
          status
          displayStatus
          estimatedDeliveryAt
          deliveredAt
          trackingInfo {
            company
            number
            url
          }
        }
        refunds(first: 10) {
          id
          createdAt
          note
          totalRefundedSet {
            shopMoney { amount currencyCode }
          }
          transactions {
            id
            kind
            gateway
            formattedGateway
            status
            processedAt
            receiptJson
            paymentDetails {
              ... on CardPaymentDetails {
                company
                number
                name
                wallet
              }
            }
          }
        }
        transactions {
          id
          kind
          status
          gateway
          formattedGateway
          processedAt
          receiptJson
          paymentDetails {
            ... on CardPaymentDetails {
              company
              number
              name
              wallet
            }
          }
        }
        events(first: 25) {
          edges {
            node {
              message
              createdAt
              action
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
        customAttributes {
          key
          value
        }
      }
    }
  }
}`;

function normalizeOrderSearchName(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

async function shopifyAdminGraphql<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": TOKEN,
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });

    const body = (await res.json()) as {
      data?: T;
      errors?: Array<{ message: string; extensions?: unknown }>;
    };

    if (!res.ok) {
      console.error(`HTTP ${res.status}`, JSON.stringify(body, null, 2));
      process.exit(1);
    }

    if (body.errors?.length) {
      console.error("GraphQL errors:", JSON.stringify(body.errors, null, 2));
      process.exit(1);
    }

    return body.data as T;
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const searchName = normalizeOrderSearchName(ORDER_NAME);
  const searchQuery = `name:${searchName}`;

  console.log("=== Shopify Order Payload Audit (READ-ONLY) ===");
  console.log("Shop:", SHOP);
  console.log("API version:", API_VERSION);
  console.log("Search query:", searchQuery);
  console.log("");

  const data = await shopifyAdminGraphql<{
    orders?: { edges?: Array<{ node?: unknown }> };
  }>(AUDIT_ORDER_QUERY, { query: searchQuery, first: 1 });

  const order = data.orders?.edges?.[0]?.node;
  if (!order) {
    console.error(`No order found for ${searchName}`);
    process.exit(1);
  }

  console.log(JSON.stringify({ orders: data.orders }, null, 2));
}

main().catch((err) => {
  console.error("Audit failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
