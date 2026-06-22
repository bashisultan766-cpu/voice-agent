"""
Shopify initial sync worker.

Paginates through products, customers, and orders using the Shopify Admin
GraphQL API, extracts ISBN/author metadata, and writes to the local caches.

Usage:
  # As CLI (from the service root):
  .venv/bin/python -m app.sync.shopify_sync

  # Programmatically:
  from app.sync.shopify_sync import sync_shopify_store
  await sync_shopify_store()
"""
from __future__ import annotations

import asyncio
import logging
import re
import sys
from typing import Optional

logger = logging.getLogger(__name__)

# ── GraphQL queries ────────────────────────────────────────────────────────────

_LIST_PRODUCTS = """
query ListProducts($first: Int!, $after: String) {
  products(first: $first, after: $after) {
    edges {
      node {
        id
        title
        handle
        tags
        variants(first: 5) {
          edges {
            node {
              id
              sku
              barcode
              price
              availableForSale
              metafields(
                identifiers: [
                  {namespace: "book", key: "isbn"}
                  {namespace: "book", key: "author"}
                ]
              ) {
                key
                value
              }
            }
          }
        }
      }
      cursor
    }
    pageInfo { hasNextPage }
  }
}
"""

_LIST_CUSTOMERS = """
query ListCustomers($first: Int!, $after: String) {
  customers(first: $first, after: $after) {
    edges {
      node {
        id
        firstName
        lastName
        phone
        email
        orders(first: 1, sortKey: CREATED_AT, reverse: true) {
          edges {
            node { name }
          }
        }
      }
      cursor
    }
    pageInfo { hasNextPage }
  }
}
"""

_LIST_ORDERS = """
query ListOrders($first: Int!, $after: String) {
  orders(first: $first, after: $after) {
    edges {
      node {
        id
        name
        customer {
          id
          phone
          email
        }
        displayFinancialStatus
        displayFulfillmentStatus
        lineItems(first: 3) {
          edges {
            node { title quantity }
          }
        }
        refunds(first: 1) {
          id
        }
        fulfillments {
          trackingInfo { number company }
        }
      }
      cursor
    }
    pageInfo { hasNextPage }
  }
}
"""

_ISBN_TAG = re.compile(r"isbn[:\s]*(\d{10,13})", re.IGNORECASE)
_DIGITS = re.compile(r"\D")


async def sync_shopify_store(
    batch_size: int = 50,
    max_retries: int = 3,
) -> dict[str, int]:
    """
    Full initial sync: products → customers → orders.

    Returns counts of synced records per entity type.
    Handles 429 / 5xx backoff automatically.
    """
    from ..config import get_settings
    from ..shopify.client import ShopifyGraphQLClient
    from ..sync.repositories import ProductCache, CustomerCache, OrderCache
    from ..caller.repository import mask_email

    settings = get_settings()
    if not settings.shopify_configured:
        logger.warning("Shopify not configured — skipping sync")
        return {"products": 0, "customers": 0, "orders": 0}

    client = ShopifyGraphQLClient(
        shop_domain=settings.SHOPIFY_SHOP_DOMAIN,
        access_token=settings.SHOPIFY_ADMIN_ACCESS_TOKEN,
        api_version=settings.SHOPIFY_API_VERSION,
    )
    product_cache = ProductCache()
    customer_cache = CustomerCache()
    order_cache = OrderCache()

    counts: dict[str, int] = {"products": 0, "customers": 0, "orders": 0}

    # ── Products ──────────────────────────────────────────────────────────────
    cursor: Optional[str] = None
    while True:
        variables = {"first": batch_size, **({"after": cursor} if cursor else {})}
        data = await _query_with_retry(client, _LIST_PRODUCTS, variables, max_retries)
        if not data:
            break
        products_conn = data.get("products", {})
        for edge in products_conn.get("edges", []):
            node = edge.get("node", {})
            await _ingest_product(node, product_cache)
            counts["products"] += 1
        page_info = products_conn.get("pageInfo", {})
        if not page_info.get("hasNextPage"):
            break
        edges = products_conn.get("edges", [])
        cursor = edges[-1]["cursor"] if edges else None

    logger.info("Sync: %d products ingested", counts["products"])

    # ── Customers ─────────────────────────────────────────────────────────────
    cursor = None
    while True:
        variables = {"first": batch_size, **({"after": cursor} if cursor else {})}
        data = await _query_with_retry(client, _LIST_CUSTOMERS, variables, max_retries)
        if not data:
            break
        customers_conn = data.get("customers", {})
        for edge in customers_conn.get("edges", []):
            node = edge.get("node", {})
            await _ingest_customer(node, customer_cache, mask_email)
            counts["customers"] += 1
        page_info = customers_conn.get("pageInfo", {})
        if not page_info.get("hasNextPage"):
            break
        edges = customers_conn.get("edges", [])
        cursor = edges[-1]["cursor"] if edges else None

    logger.info("Sync: %d customers ingested", counts["customers"])

    # ── Orders ────────────────────────────────────────────────────────────────
    cursor = None
    while True:
        variables = {"first": batch_size, **({"after": cursor} if cursor else {})}
        data = await _query_with_retry(client, _LIST_ORDERS, variables, max_retries)
        if not data:
            break
        orders_conn = data.get("orders", {})
        for edge in orders_conn.get("edges", []):
            node = edge.get("node", {})
            await _ingest_order(node, order_cache, mask_email)
            counts["orders"] += 1
        page_info = orders_conn.get("pageInfo", {})
        if not page_info.get("hasNextPage"):
            break
        edges = orders_conn.get("edges", [])
        cursor = edges[-1]["cursor"] if edges else None

    logger.info("Sync: %d orders ingested", counts["orders"])
    logger.info("Sync complete: %s", counts)
    return counts


# ── Ingest helpers ─────────────────────────────────────────────────────────────

async def _ingest_product(node: dict, cache) -> None:
    from ..sync.repositories import CachedProduct
    try:
        product_id = node.get("id", "")
        title = node.get("title", "")
        handle = node.get("handle", "")
        tags = node.get("tags", [])

        isbn = ""
        author = ""
        variant_id = ""
        price = ""
        available = False

        for tag in (tags if isinstance(tags, list) else []):
            m = _ISBN_TAG.search(str(tag))
            if m:
                isbn = m.group(1)
                break

        variants = node.get("variants", {}).get("edges", [])
        for v_edge in variants[:1]:
            v = v_edge.get("node", {})
            variant_id = v.get("id", "")
            price = v.get("price", "")
            available = v.get("availableForSale", False)
            barcode = v.get("barcode") or ""
            sku = v.get("sku") or ""
            if not isbn:
                for src in (barcode, sku):
                    digits = _DIGITS.sub("", src)
                    if len(digits) in (10, 13):
                        isbn = digits
                        break
            for mf in v.get("metafields") or []:
                if mf and mf.get("key") == "isbn" and mf.get("value"):
                    isbn = mf["value"]
                elif mf and mf.get("key") == "author" and mf.get("value"):
                    author = mf["value"]

        if product_id and title:
            await cache.set(CachedProduct(
                product_id=product_id,
                title=title,
                handle=handle,
                isbn=isbn,
                author=author,
                variant_id=variant_id,
                price=price,
                available=available,
            ))
    except Exception as exc:
        logger.warning("Failed to ingest product %s: %s", node.get("id", "?"), exc)


async def _ingest_customer(node: dict, cache, mask_email_fn) -> None:
    from ..sync.repositories import CachedCustomer
    from ..caller.repository import normalize_phone
    try:
        customer_id = node.get("id", "")
        first = node.get("firstName") or ""
        last = node.get("lastName") or ""
        display_name = f"{first} {last}".strip()
        phone = node.get("phone") or ""
        email = node.get("email") or ""
        norm_phone = normalize_phone(phone)
        email_masked = mask_email_fn(email) if email else ""
        last_order_number = ""
        orders = node.get("orders", {}).get("edges", [])
        if orders:
            last_order_number = orders[0].get("node", {}).get("name", "")

        if customer_id and norm_phone:
            await cache.set(CachedCustomer(
                customer_id=customer_id,
                normalized_phone=norm_phone,
                display_name=display_name,
                email_masked=email_masked,
                last_order_number=last_order_number,
            ))
    except Exception as exc:
        logger.warning("Failed to ingest customer %s: %s", node.get("id", "?"), exc)


async def _ingest_order(node: dict, cache, mask_email_fn) -> None:
    from ..sync.repositories import CachedOrder
    from ..caller.repository import normalize_phone
    try:
        order_id = node.get("id", "")
        order_number = node.get("name", "")
        customer = node.get("customer") or {}
        customer_id = customer.get("id", "")
        phone = customer.get("phone") or ""
        email = customer.get("email") or ""
        norm_phone = normalize_phone(phone)
        email_masked = mask_email_fn(email) if email else ""

        financial_status = node.get("displayFinancialStatus", "")
        fulfillment_status = node.get("displayFulfillmentStatus", "")
        refund_count = len(node.get("refunds") or [])

        items = [
            f"{e['node']['quantity']}x {e['node']['title']}"
            for e in (node.get("lineItems", {}).get("edges") or [])
        ]
        line_items_summary = ", ".join(items[:3])

        tracking_parts = []
        for f in node.get("fulfillments") or []:
            for t in f.get("trackingInfo") or []:
                num = t.get("number") or ""
                company = t.get("company") or ""
                if num:
                    tracking_parts.append(f"{company} {num}".strip())
        tracking_summary = "; ".join(tracking_parts[:2])

        if order_id and order_number:
            await cache.set(CachedOrder(
                order_id=order_id,
                order_number=order_number,
                customer_id=customer_id,
                normalized_phone=norm_phone,
                email_masked=email_masked,
                financial_status=financial_status,
                fulfillment_status=fulfillment_status,
                tracking_summary=tracking_summary,
                refund_count=refund_count,
                line_items_summary=line_items_summary,
            ))
    except Exception as exc:
        logger.warning("Failed to ingest order %s: %s", node.get("id", "?"), exc)


# ── Retry wrapper ──────────────────────────────────────────────────────────────

async def _query_with_retry(
    client,
    query: str,
    variables: dict,
    max_retries: int,
) -> Optional[dict]:
    backoff = 1.0
    for attempt in range(1, max_retries + 1):
        try:
            result = await client.query(query, variables)
            return result
        except Exception as exc:
            msg = str(exc).lower()
            if "429" in msg or "throttle" in msg or "rate" in msg:
                sleep_secs = backoff * attempt
                logger.warning("Shopify rate-limited — sleeping %.1fs", sleep_secs)
                await asyncio.sleep(sleep_secs)
            elif attempt < max_retries:
                logger.warning("Shopify query error (attempt %d/%d): %s", attempt, max_retries, exc)
                await asyncio.sleep(backoff)
            else:
                logger.error("Shopify query failed after %d retries: %s", max_retries, exc)
                return None
    return None


# ── CLI entry point ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import os
    logging.basicConfig(level=logging.INFO, stream=sys.stdout)
    os.environ.setdefault("DEBUG", "true")

    async def _main():
        counts = await sync_shopify_store()
        print(f"Sync complete: {counts}")

    asyncio.run(_main())
