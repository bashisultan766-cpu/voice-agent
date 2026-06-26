"""
Voice-agent Shopify tool implementations — 7 tools.

All tools return JSON strings for insertion into OpenAI tool-result messages.
No raw PII, admin tokens, or stack traces are ever returned to the caller.
"""
from __future__ import annotations

import json
import logging
from typing import Optional, TYPE_CHECKING

import httpx

from ..shopify.client import get_shopify_client
from ..shopify.graphql_queries import (
    CREATE_DRAFT_ORDER,
    GET_ORDER_WITH_REFUNDS,
    GET_PRODUCT_BY_HANDLE,
    GET_PRODUCT_BY_ID,
    LOOKUP_ORDERS,
    SEARCH_PRODUCTS,
    SEARCH_VARIANTS_BY_BARCODE,
)
from ..state.session_store import shopify_cache_get, shopify_cache_set
from ..config import get_settings
from .isbn import extract_isbn_candidate, looks_like_isbn_fragment, normalize_isbn
from .email_sender import send_payment_link_email

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)


def _mask(val: str, show: int = 2) -> str:
    """Partially mask a string for safe logging."""
    if not val or len(val) <= show * 2:
        return "***"
    return val[:show] + "***" + val[-show:]


def _normalise_product(node: dict) -> dict:
    variants = [
        {
            "id": e["node"]["id"],
            "title": e["node"]["title"],
            "price": e["node"]["price"],
            "available": e["node"]["availableForSale"],
            "inventory": e["node"].get("inventoryQuantity"),
        }
        for e in node.get("variants", {}).get("edges", [])
    ]
    cheapest = min(variants, key=lambda v: float(v["price"]), default=None)
    return {
        "id": node["id"],
        "title": node["title"],
        "handle": node["handle"],
        "url": node.get("onlineStoreUrl") or "",
        "price": cheapest["price"] if cheapest else "N/A",
        "available": any(v["available"] for v in variants),
        "variants": variants,
    }


async def _search_by_isbn(isbn: str, limit: int) -> Optional[dict]:
    """Barcode lookup in Shopify productVariants. Returns payload dict or None on miss."""
    client = get_shopify_client()
    try:
        data = await client.execute(
            SEARCH_VARIANTS_BY_BARCODE,
            variables={"barcode": f"barcode:{isbn}", "first": limit},
        )
        edges = data.get("data", {}).get("productVariants", {}).get("edges", [])
        if not edges:
            return None
        results = []
        for e in edges:
            v = e["node"]
            prod = v.get("product", {})
            metafields = {
                f"{m['namespace']}.{m['key']}": m["value"]
                for m in (prod.get("metafields") or [])
                if m
            }
            results.append({
                "id": prod.get("id", ""),
                "title": prod.get("title", ""),
                "handle": prod.get("handle", ""),
                "url": prod.get("onlineStoreUrl") or "",
                "price": v.get("price", "N/A"),
                "available": v.get("availableForSale", False),
                "isbn": isbn,
                "author": (
                    metafields.get("book.author")
                    or metafields.get("custom.author")
                    or ""
                ),
                "variants": [
                    {
                        "id": v["id"],
                        "title": v.get("title", "Default"),
                        "price": v.get("price", "N/A"),
                        "available": v.get("availableForSale", False),
                        "inventory": v.get("inventoryQuantity"),
                    }
                ],
            })
        return {"results": results, "count": len(results), "matched_isbn": isbn}
    except Exception as exc:
        logger.error("ISBN barcode search failed: %s", exc)
        return None


async def _notify_support_escalation(
    caller_masked: str, reason: str, summary: str
) -> None:
    """Fire-and-forget: plain text escalation notification via Resend."""
    settings = get_settings()
    if not settings.SUPPORT_EMAIL or not settings.RESEND_API_KEY:
        return
    from_addr = (
        f"{settings.RESEND_FROM_NAME} <{settings.RESEND_FROM_EMAIL}>"
        if settings.RESEND_FROM_NAME
        else settings.RESEND_FROM_EMAIL
    )
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                "https://api.resend.com/emails",
                headers={
                    "Authorization": f"Bearer {settings.RESEND_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "from": from_addr,
                    "to": [settings.SUPPORT_EMAIL],
                    "subject": f"[Voice Agent] Escalation: {reason[:60]}",
                    "text": (
                        f"Caller: {caller_masked}\n\n"
                        f"Reason: {reason}\n\n"
                        f"Summary: {summary}"
                    ),
                },
            )
    except Exception:
        logger.warning("Failed to send escalation support notification")


# ── Tool functions ─────────────────────────────────────────────────────────────


def _cached_product_to_result(product) -> dict:
    """Convert a CachedProduct to the same shape as _normalise_product."""
    return {
        "id": product.product_id,
        "title": product.title,
        "handle": product.handle,
        "url": "",
        "price": product.price or "N/A",
        "available": product.available,
        "author": product.author,
        "variants": [
            {
                "id": product.variant_id,
                "title": "Default",
                "price": product.price or "N/A",
                "available": product.available,
            }
        ] if product.variant_id else [],
    }


def _inventory_status(product: dict) -> str:
    """Map Shopify availability to customer-safe inventory status."""
    available = product.get("available")
    if available is True:
        return "in_stock"
    if available is False:
        inv = product.get("inventory")
        if inv is not None and int(inv) <= 0:
            return "out_of_stock"
        return "out_of_stock"
    return "unknown"


def _enrich_catalog_payload(payload: dict) -> dict:
    """Add inventory_status and not_found flag for catalog_search consumers."""
    results = payload.get("results") or []
    for item in results:
        item["inventory_status"] = _inventory_status(item)
        if not item.get("isbn") and item.get("variants"):
            for v in item["variants"]:
                if v.get("barcode"):
                    item["isbn"] = v["barcode"]
                    break
    payload["results"] = results
    payload["count"] = len(results)
    payload["not_found"] = payload.get("count", 0) == 0 and not payload.get("error")
    return payload


def _search_products_response(payload: dict) -> str:
    """Normalize search payload and set not_found before JSON serialization."""
    if not payload.get("needs_more_digits"):
        results = payload.get("results") or []
        count = payload.get("count")
        if count is None:
            count = len(results)
            payload["count"] = count
        if "not_found" not in payload:
            payload["not_found"] = (
                int(count or 0) == 0 and not results and not payload.get("error")
            )
    return json.dumps(payload)


async def search_products(query: str, limit: int = 5) -> str:
    """
    Search Shopify catalog.

    Cache-first order:
      1. ProductCache: ISBN index (if query looks like an ISBN)
      2. ProductCache: exact title match
      3. ProductCache: handle match
      4. Redis search-result cache (shopify_cache_get)
      5. Shopify live API (barcode lookup for ISBNs, then title search)

    Partial ISBN fragments (e.g. "9798") are rejected — caller must provide
    a complete 10- or 13-digit ISBN before a catalog lookup runs.
    """
    limit = max(1, min(10, limit))
    settings = get_settings()

    if looks_like_isbn_fragment(query) and not extract_isbn_candidate(query):
        return json.dumps({
            "results": [],
            "count": 0,
            "not_found": False,
            "needs_more_digits": True,
            "message": (
                "That looks like a partial ISBN. Please read the rest of the ISBN — "
                "all 10 or 13 digits."
            ),
        })
    # ── 1-3. ProductCache lookups (Redis, sub-ms) ──────────────────────────────
    try:
        from ..sync.repositories import ProductCache
        pc = ProductCache()

        isbn = extract_isbn_candidate(query) or normalize_isbn(query)
        if isbn:
            cached_product = await pc.get_by_isbn(isbn)
            if cached_product:
                logger.debug("ProductCache ISBN hit: %s", isbn)
                payload = {
                    "results": [_cached_product_to_result(cached_product)],
                    "count": 1,
                    "source": "cache",
                }
                return _search_products_response(payload)

        cached_product = await pc.get_by_title(query)
        if cached_product:
            logger.debug("ProductCache title hit: %r", query)
            payload = {
                "results": [_cached_product_to_result(cached_product)],
                "count": 1,
                "source": "cache",
            }
            return _search_products_response(payload)

        handle = query.lower().strip().replace(" ", "-")
        cached_product = await pc.get_by_handle(handle)
        if cached_product:
            logger.debug("ProductCache handle hit: %r", handle)
            payload = {
                "results": [_cached_product_to_result(cached_product)],
                "count": 1,
                "source": "cache",
            }
            return _search_products_response(payload)
    except Exception as exc:
        logger.debug("ProductCache lookup skipped: %s", exc)

    # ── 4. Redis search-result cache ───────────────────────────────────────────
    cache_key = f"search:{query.lower().strip()}:{limit}"
    cached = await shopify_cache_get(cache_key)
    if cached is not None:
        logger.debug("Shopify search cache hit: %s", query)
        return _search_products_response(dict(cached))

    client = get_shopify_client()
    if not client.configured:
        return _search_products_response({"error": "Shopify not configured", "results": []})

    # ── 5. Live Shopify API ────────────────────────────────────────────────────
    isbn = extract_isbn_candidate(query) or normalize_isbn(query)
    if isbn:
        isbn_result = await _search_by_isbn(isbn, limit)
        if isbn_result and isbn_result.get("count", 0) > 0:
            await shopify_cache_set(cache_key, isbn_result, ttl=settings.SHOPIFY_CACHE_TTL_SECS)
            return _search_products_response(isbn_result)

    try:
        data = await client.execute(
            SEARCH_PRODUCTS,
            variables={"query": query, "first": limit},
        )
        edges = data.get("data", {}).get("products", {}).get("edges", [])
        results = [_normalise_product(e["node"]) for e in edges]
        payload = {"results": results, "count": len(results)}
        await shopify_cache_set(cache_key, payload, ttl=settings.SHOPIFY_CACHE_TTL_SECS)
        return _search_products_response(payload)
    except Exception as exc:
        logger.error("search_products failed: %s", exc)
        return _search_products_response({
            "error": "Shopify search temporarily unavailable.",
            "results": [],
        })


async def get_product_details(product_id_or_handle: str) -> str:
    """Fetch full details for one product by GID or URL handle."""
    client = get_shopify_client()
    if not client.configured:
        return json.dumps({"error": "Shopify not configured"})

    try:
        if product_id_or_handle.startswith("gid://"):
            data = await client.execute(
                GET_PRODUCT_BY_ID,
                variables={"id": product_id_or_handle},
            )
            node = data.get("data", {}).get("product")
        else:
            data = await client.execute(
                GET_PRODUCT_BY_HANDLE,
                variables={"handle": product_id_or_handle},
            )
            node = data.get("data", {}).get("productByHandle")

        if not node:
            return json.dumps({"found": False, "product": None})

        return json.dumps({"found": True, "product": _normalise_product(node)})

    except Exception as exc:
        logger.error("get_product_details failed: %s", exc)
        return json.dumps({"error": "Could not fetch product details."})


async def lookup_order(
    order_number: Optional[str] = None,
    email: Optional[str] = None,
    phone: Optional[str] = None,
    session: Optional["SessionState"] = None,
) -> str:
    """
    Look up a Shopify order.

    Verification: order_number + (email or phone) → full details.
    order_number only → status only.
    """
    client = get_shopify_client()
    if not client.configured:
        return json.dumps({"error": "Shopify not configured"})

    if not any([order_number, email, phone]):
        return json.dumps({"error": "Provide order_number, email, or phone to look up an order."})

    # Supplement with already-verified session context.
    if session:
        if not email and session.verified_email and session.caller_email:
            email = session.caller_email
        inbound = (getattr(session, "from_number", "") or "").strip()
        if not phone and inbound:
            if getattr(session, "verified_phone", False) or order_number:
                phone = inbound

    try:
        parts = []
        if order_number:
            parts.append(f"name:#{order_number.lstrip('#')}")
        if email:
            parts.append(f"email:{email}")
        if phone:
            parts.append(f"phone:{phone}")

        data = await client.execute(
            LOOKUP_ORDERS,
            variables={"query": " AND ".join(parts), "first": 3},
        )
        edges = data.get("data", {}).get("orders", {}).get("edges", [])
        if not edges:
            return json.dumps({"found": False, "message": "No matching order found."})

        node = edges[0]["node"]
        verified = bool(order_number and (email or phone))

        if session and order_number:
            session.last_order_number = node["name"]

        from ..shopify.order_privacy import (
            card_last4_from_transactions,
            customer_display_name,
            mask_email_for_voice,
        )

        order_email = (node.get("email") or "").strip()
        customer = node.get("customer") or {}
        if not order_email:
            order_email = (customer.get("email") or "").strip()
        customer_name = customer_display_name(customer)
        transactions = node.get("transactions") or []
        card_last4 = card_last4_from_transactions(transactions)

        result: dict = {
            "found": True,
            "order_number": node["name"],
            "status": node["displayFinancialStatus"],
            "fulfillment_status": node["displayFulfillmentStatus"],
        }

        if not verified:
            result["verification_required"] = True
            result["message"] = (
                "For security, provide the email or phone number on this order "
                "to view line items, tracking, or payment details."
            )
            result["suggested_response"] = (
                f"I found order {node['name']}. The financial status is "
                f"{node['displayFinancialStatus']} and fulfillment is "
                f"{node['displayFulfillmentStatus']}. "
                "To share more details, I'll need to verify your email or phone number."
            )
            return json.dumps(result)

        line_edges = node.get("lineItems", {}).get("edges", [])
        if line_edges:
            result["items"] = [
                f"{e['node']['quantity']}x {e['node']['title']}"
                for e in line_edges
            ]
            result["book_titles"] = [e["node"]["title"] for e in line_edges]

        subtotal = node.get("subtotalPriceSet", {}).get("shopMoney", {})
        if subtotal.get("amount") is not None:
            result["subtotal"] = (
                f"{subtotal.get('amount', '?')} {subtotal.get('currencyCode', '')}"
            )
        shipping_money = node.get("totalShippingPriceSet", {}).get("shopMoney", {})
        if shipping_money.get("amount") is not None:
            result["shipping"] = (
                f"{shipping_money.get('amount', '?')} {shipping_money.get('currencyCode', '')}"
            )
        total_money = node.get("totalPriceSet", {}).get("shopMoney", {})
        if total_money.get("amount") is not None:
            result["total"] = (
                f"{total_money.get('amount', '?')} {total_money.get('currencyCode', '')}"
            )

        if verified:
            result["note"] = node.get("note") or ""
            result["tags"] = node.get("tags") or []
            result["custom_attributes"] = {
                a.get("key", ""): a.get("value", "")
                for a in (node.get("customAttributes") or [])
            }
            if result.get("subtotal"):
                result["subtotal_before_shipping"] = result["subtotal"]
            tracking = (node.get("fulfillments") or [{}])[0]
            tracking_info = (tracking.get("trackingInfo") or [{}])[0] if tracking else {}
            result["tracking_number"] = tracking_info.get("number")
            result["tracking_url"] = tracking_info.get("url")
            ship = node.get("shippingAddress") or {}
            if ship:
                result["shipping_address"] = {
                    "name": ship.get("name") or "",
                    "company": ship.get("company") or "",
                    "address1": ship.get("address1") or "",
                    "address2": ship.get("address2") or "",
                    "city": ship.get("city") or "",
                    "state": ship.get("provinceCode") or "",
                    "zip": ship.get("zip") or "",
                }
                try:
                    from ..facility.facility_resolver import facility_from_order

                    hint = facility_from_order(result)
                    if hint:
                        result["facility_hint"] = hint
                except Exception:  # noqa: BLE001
                    pass
            if customer_name:
                result["customer_name"] = customer_name
            if order_email:
                result["email_masked"] = mask_email_for_voice(order_email)
            if card_last4:
                result["payment_card_last4"] = card_last4
            parts = [
                f"Order {node['name']} is {node['displayFinancialStatus']} "
                f"with fulfillment status {node['displayFulfillmentStatus']}."
            ]
            if result.get("items"):
                parts.append("Line items: " + ", ".join(result["items"]) + ".")
            if result.get("subtotal"):
                parts.append(
                    f"Subtotal before shipping is {result['subtotal']}. "
                    f"Shipping was {result.get('shipping', 'unknown')}."
                )
            if result.get("total"):
                parts.append(f"Order total is {result['total']}.")
            if result.get("tracking_number"):
                parts.append(f"Tracking number is {result['tracking_number']}.")
            if card_last4:
                parts.append(f"Payment card on file ends in {card_last4}.")
            if order_email:
                parts.append(f"Order email on file is {result['email_masked']}.")
            result["suggested_response"] = " ".join(parts)
            if session:
                session.verified_email = bool(email)
                session.verified_phone = bool(phone)
        else:
            # Unreachable — verified branch returns above; kept for safety.
            result["verification_required"] = True

        return json.dumps(result)

    except Exception as exc:
        logger.error("lookup_order failed: %s", exc)
        return json.dumps({"error": "Order lookup temporarily unavailable."})


def order_record_from_lookup(result: dict) -> dict | None:
    """
    Normalize lookup_order JSON for facility workers.

    Supports legacy ``orders[]`` payloads and the flat verified lookup shape.
    """
    if not result or not result.get("found"):
        return None
    if result.get("orders"):
        orders = result["orders"]
        if orders and isinstance(orders[0], dict):
            return orders[0]
    if not any(
        result.get(key) is not None
        for key in ("order_number", "tags", "note", "custom_attributes", "customAttributes")
    ):
        return None

    attrs = result.get("custom_attributes") or result.get("customAttributes") or {}
    if isinstance(attrs, list):
        custom_attributes = attrs
    else:
        custom_attributes = [{"key": k, "value": v} for k, v in attrs.items()]

    tags = result.get("tags") or []
    if isinstance(tags, str):
        tags = [t.strip() for t in tags.split(",") if t.strip()]

    return {
        "note": result.get("note") or "",
        "tags": tags,
        "customAttributes": custom_attributes,
    }


async def get_refund_status(
    order_number: str,
    email: Optional[str] = None,
    phone: Optional[str] = None,
    session: Optional["SessionState"] = None,
) -> str:
    """
    Fetch refund details. Requires order_number + email or phone verification.
    Returns refund amounts, dates, and items — no raw transaction IDs.
    """
    client = get_shopify_client()
    if not client.configured:
        return json.dumps({"error": "Shopify not configured"})

    if session:
        if not email and session.verified_email and session.caller_email:
            email = session.caller_email
        if not phone and session.verified_phone:
            phone = session.from_number

    if not (email or phone):
        return json.dumps({
            "verified": False,
            "message": (
                "To protect your account, I need your email address or phone number "
                "to share refund details. What email is on your account?"
            ),
        })

    try:
        parts = [f"name:#{order_number.lstrip('#')}"]
        if email:
            parts.append(f"email:{email}")
        if phone:
            parts.append(f"phone:{phone}")

        lookup_data = await client.execute(
            LOOKUP_ORDERS,
            variables={"query": " AND ".join(parts), "first": 1},
        )
        edges = lookup_data.get("data", {}).get("orders", {}).get("edges", [])
        if not edges:
            return json.dumps({"found": False, "message": "No matching order found."})

        order_node = edges[0]["node"]

        refund_data = await client.execute(
            GET_ORDER_WITH_REFUNDS,
            variables={"id": order_node["id"]},
        )
        order = refund_data.get("data", {}).get("order", {})
        refunds = order.get("refunds") or []

        from ..shopify.order_privacy import (
            card_last4_from_transactions,
            customer_display_name,
            mask_email_for_voice,
        )

        order_email = (order.get("email") or "").strip()
        customer = order.get("customer") or {}
        if not order_email:
            order_email = (customer.get("email") or "").strip()
        customer_name = customer_display_name(customer)
        card_last4 = card_last4_from_transactions(order.get("transactions") or [])

        if session:
            session.verified_email = bool(email)
            session.verified_phone = bool(phone)

        if not refunds:
            return json.dumps({
                "found": True,
                "order_number": order_node["name"],
                "refund_count": 0,
                "message": "No refunds have been issued for this order.",
            })

        refund_summaries = []
        for r in refunds:
            total = r.get("totalRefundedSet", {}).get("shopMoney", {})
            items = [
                f"{li['node']['quantity']}x {li['node']['lineItem']['title']}"
                for li in r.get("refundLineItems", {}).get("edges", [])
            ]
            gateways = list({
                t.get("gateway", "")
                for t in (r.get("transactions") or [])
                if t.get("gateway")
            })
            r_last4 = card_last4_from_transactions(r.get("transactions") or []) or card_last4
            refund_summaries.append({
                "date": (r.get("createdAt") or "")[:10],
                "amount": f"{total.get('amount', '?')} {total.get('currencyCode', '')}",
                "items": items,
                "refunded_via": gateways,
                "payment_card_last4": r_last4 or "",
            })

        latest = refund_summaries[-1]
        email_masked = mask_email_for_voice(order_email) if order_email else ""
        suggested = (
            f"Your refund of {latest['amount']} was processed on {latest['date']}."
        )
        if latest.get("payment_card_last4"):
            suggested += f" It was returned to the card ending in {latest['payment_card_last4']}."
        if email_masked:
            suggested += f" Confirmation was sent to {email_masked}."
        if customer_name:
            suggested = f"{customer_name}, {suggested}"

        return json.dumps({
            "found": True,
            "order_number": order_node["name"],
            "refund_count": len(refund_summaries),
            "refunds": refund_summaries,
            "email_masked": email_masked,
            "payment_card_last4": latest.get("payment_card_last4") or card_last4,
            "customer_name": customer_name,
            "suggested_response": suggested,
        })

    except Exception as exc:
        logger.error("get_refund_status failed: %s", exc)
        return json.dumps({"error": "Refund lookup temporarily unavailable."})


async def create_checkout_link(
    items: list[dict],
    email: Optional[str] = None,
    phone: Optional[str] = None,
    customer_name: Optional[str] = None,
    session: Optional["SessionState"] = None,
) -> str:
    """
    Create a Shopify draft order. Prevents duplicate draft orders within the same call.

    Safety: when session is present, requires confirmed cart (items with quantity ≥ 1 and
    variant_id). Email is sourced from session.confirmed_email only; raw LLM email args are
    ignored (not blocked — checkout can still proceed without email).
    """
    from ..payment.safety import require_confirmed_cart, validate_tool_email_arg

    client = get_shopify_client()
    if not client.configured:
        return json.dumps({"error": "Shopify not configured"})

    if not items:
        return json.dumps({"error": "No items provided for checkout."})

    if session:
        # Gate: block checkout creation during email confirmation
        pfs = getattr(session, "payment_flow_status", "idle") or "idle"
        if pfs == "awaiting_email_confirmation":
            logger.info(
                "payment_tool_result tool=create_checkout_link allowed=false "
                "reason=email_confirmation_pending",
            )
            return json.dumps({
                "success": False,
                "error": (
                    "I need to confirm your email address before I can create the payment link. "
                    "Is the email I have correct? Please say yes or no."
                ),
            })

        if not customer_name and session.caller_name:
            customer_name = session.caller_name

        if session.pending_checkout_url:
            return json.dumps({
                "success": True,
                "order_name": session.pending_draft_order_id,
                "checkout_url": session.pending_checkout_url,
                "duplicate": True,
                "message": "You already have a payment link from this call. Shall I email it to you?",
            })

        # Gate on confirmed cart when session is present
        cart_result = require_confirmed_cart(session, checkout_items=items)
        if not cart_result.allowed:
            logger.info(
                "payment_tool_result tool=create_checkout_link allowed=false "
                "reason=%s missing=%s",
                cart_result.reason, cart_result.missing_fields,
            )
            return json.dumps({"success": False, "error": cart_result.safe_message})

        # Resolve email: require confirmed_email — never create NEW checkout without it
        from ..payment.email_state import get_canonical_confirmed_email
        from ..payment.safety import require_confirmed_email

        email_result = require_confirmed_email(session)
        if not email_result.allowed:
            logger.info(
                "payment_tool_result tool=create_checkout_link allowed=false "
                "reason=%s",
                email_result.reason,
            )
            return json.dumps({"success": False, "error": email_result.safe_message})

        confirmed_email = get_canonical_confirmed_email(session)
        if email and email.strip():
            arg_result = validate_tool_email_arg(email, session)
            if not arg_result.allowed and arg_result.reason == "rejected_candidate":
                return json.dumps({"success": False, "error": arg_result.safe_message})
            # Non-rejected mismatch: ignore LLM arg, use confirmed_email (don't block checkout)
            email = confirmed_email or None
        elif confirmed_email:
            email = confirmed_email

    try:
        # v4.8: filter out internal fee items before sending to Shopify
        from ..payment.line_item_filter import filter_checkout_line_items
        filter_result = filter_checkout_line_items(items)
        if filter_result.excluded_fee_count:
            logger.warning(
                "checkout_line_filter excluded_fee_count=%d sid=%s",
                filter_result.excluded_fee_count,
                session.call_sid[:6] if session else "none",
            )
        clean_items = filter_result.included or items

        line_items = [
            {"variantId": item["variant_id"], "quantity": item.get("quantity", 1)}
            for item in clean_items
        ]
        from ..payment.drop_shipping_fee import append_fee_to_draft_line_items

        line_items = append_fee_to_draft_line_items(line_items, clean_items)
        draft_input: dict = {"lineItems": line_items}
        if email:
            draft_input["email"] = email
        if phone:
            draft_input["phone"] = phone
        if customer_name:
            draft_input["note"] = f"Phone order for {customer_name}"

        data = await client.execute(CREATE_DRAFT_ORDER, variables={"input": draft_input})
        result = data.get("data", {}).get("draftOrderCreate", {})
        errors = result.get("userErrors", [])
        if errors:
            msgs = "; ".join(e["message"] for e in errors)
            logger.warning("Draft order errors: %s", msgs)
            return json.dumps({"success": False, "error": msgs})

        draft = result.get("draftOrder", {})
        checkout_url = draft.get("invoiceUrl", "")
        draft_id = draft.get("name", "")

        if session and checkout_url:
            session.pending_checkout_url = checkout_url
            session.pending_draft_order_id = draft_id
            session.checkout_url = checkout_url
            session.checkout_id = draft_id

        return json.dumps({
            "success": True,
            "order_name": draft_id,
            "checkout_url": checkout_url,
            "message": "Payment link created. Shall I email it to you?",
        })

    except Exception as exc:
        logger.error("create_checkout_link failed: %s", exc)
        return json.dumps({"success": False, "error": "Could not create checkout link at this time."})


def _checkout_lines_for_email(session: Optional["SessionState"]) -> list[dict]:
    """Confirmed cart lines plus drop shipping fee for branded payment email."""
    if session is None:
        return []
    try:
        from ..cart.session import get_ledger
        from ..payment.drop_shipping_fee import checkout_email_lines
        from ..payment.payment_destination_groups import group_checkout_items, refresh_payment_groups_from_cart

        refresh_payment_groups_from_cart(session)
        items = group_checkout_items(session) or get_ledger(session).to_checkout_items()
        return checkout_email_lines(items)
    except Exception:  # noqa: BLE001
        return []


async def send_payment_link_email_tool(
    email: str = "",
    customer_email: str = "",
    to_email: str = "",
    session: Optional["SessionState"] = None,
) -> str:
    """
    Email the pending checkout link to the caller.

    Safety: enforces confirmed_email via PaymentSafetyGuard. Raw LLM email arg is
    validated against session.confirmed_email; rejected candidates are hard-blocked.
    Never sends to pending_email or unconfirmed addresses.
    """
    from ..payment.safety import validate_tool_email_arg, require_payment_send_ready_with_checkout
    from ..payment.email_state import (
        assert_ready_for_payment_send,
        get_canonical_confirmed_email,
        log_payment_flow_diagnostics,
    )
    from ..agent_runtime.payment_flow_state import (
        PAYMENT_FAILURE_MESSAGE,
        PAYMENT_SUCCESS_MESSAGE,
        build_payment_tool_result,
        resolve_tool_email,
    )

    tool_email = (email or customer_email or to_email or "").strip().lower()
    if not tool_email and session:
        tool_email = resolve_tool_email(
            {"email": email, "customer_email": customer_email, "to_email": to_email},
            session,
        )

    if not session:
        return json.dumps(build_payment_tool_result(
            success=False,
            email_sent=False,
            customer_message="No session available. Cannot verify email address.",
            error_code="no_session",
            retryable=True,
        ))

    log_payment_flow_diagnostics(session, stage="send_payment_link_email_tool")

    if not assert_ready_for_payment_send(session, stage="send_payment_link_email_tool"):
        session.last_payment_attempt_status = "blocked"
        return json.dumps(build_payment_tool_result(
            success=False,
            email_sent=False,
            customer_message=(
                "I need a confirmed email address to send the payment link. "
                "What email should I use?"
            ),
            error_code="email_unconfirmed",
            retryable=True,
        ))

    ready_result = require_payment_send_ready_with_checkout(session)
    if not ready_result.allowed:
        logger.info(
            "payment_tool_result tool=send_payment_link_email allowed=false "
            "reason=%s missing=%s",
            ready_result.reason, ready_result.missing_fields,
        )
        session.last_payment_attempt_status = "blocked"
        return json.dumps(build_payment_tool_result(
            success=False,
            email_sent=False,
            customer_message=ready_result.safe_message,
            error_code=ready_result.reason,
            retryable=True,
            escalation_recommended=ready_result.reason == "no_checkout_url",
        ))

    arg_result = validate_tool_email_arg(tool_email or None, session)
    if not arg_result.allowed:
        logger.info(
            "payment_tool_result tool=send_payment_link_email allowed=false "
            "reason=%s",
            arg_result.reason,
        )
        session.last_payment_attempt_status = "blocked"
        return json.dumps(build_payment_tool_result(
            success=False,
            email_sent=False,
            customer_message=arg_result.safe_message,
            error_code=arg_result.reason,
            retryable=True,
        ))

    confirmed_email = get_canonical_confirmed_email(session)
    if not confirmed_email:
        session.last_payment_attempt_status = "blocked"
        logger.error(
            "payment_send_impossible sid=%s stage=send_payment_link_email_tool "
            "confirmed_missing_after_assert",
            (session.call_sid or "")[:6],
        )
        return json.dumps(build_payment_tool_result(
            success=False,
            email_sent=False,
            customer_message=(
                "I need a confirmed email address to send the payment link. "
                "What email should I use?"
            ),
            error_code="email_unconfirmed",
            retryable=True,
        ))

    if confirmed_email in session.payment_email_sent_to:
        if (
            getattr(session, "email_send_success", False)
            and getattr(session, "payment_link_sent", False)
        ):
            return json.dumps(build_payment_tool_result(
                success=True,
                email_sent=True,
                customer_message="I already sent the payment link to your email during this call.",
                error_code="duplicate",
            ))
        session.payment_email_sent_to = [
            e for e in session.payment_email_sent_to if e != confirmed_email
        ]

    checkout_url = (
        (getattr(session, "pending_checkout_url", "") or "").strip()
        or (getattr(session, "checkout_url", "") or "").strip()
    )
    if not checkout_url:
        session.last_payment_attempt_status = "blocked"
        return json.dumps(build_payment_tool_result(
            success=False,
            email_sent=False,
            customer_message=(
                "No payment link has been created yet. "
                "I'm creating one now — one moment please."
            ),
            error_code="no_checkout_url",
            retryable=True,
        ))

    result = await send_payment_link_email(
        email=confirmed_email,
        checkout_url=checkout_url,
        product_summary=session.last_product_title or "your selected items",
        caller_name=session.caller_name or None,
        order_or_draft_id=session.pending_draft_order_id or None,
        order_lines=_checkout_lines_for_email(session),
    )

    if result.get("success"):
        session.payment_email_sent_to.append(confirmed_email)
        session.last_payment_attempt_status = "success"
        logger.info(
            "payment_tool_result tool=send_payment_link_email allowed=true "
            "email=%s",
            arg_result.confirmed_email_masked or "***",
        )
        if hasattr(session, "payment_flow_status"):
            session.payment_flow_status = "payment_sent"
        return json.dumps(build_payment_tool_result(
            success=True,
            email_sent=True,
            customer_message=PAYMENT_SUCCESS_MESSAGE,
        ))

    session.last_payment_attempt_status = "failed"
    return json.dumps(build_payment_tool_result(
        success=False,
        email_sent=False,
        customer_message=PAYMENT_FAILURE_MESSAGE,
        error_code="email_send_failed",
        retryable=True,
        escalation_recommended=True,
    ))


async def escalate_to_human(
    reason: str,
    caller_phone: str = "",
    summary: str = "",
    session: Optional["SessionState"] = None,
) -> str:
    """Record escalation and optionally notify support via email."""
    masked = _mask(caller_phone) if caller_phone else "unknown"
    logger.info(
        "Escalation | reason=%r caller=%s summary=%r",
        reason,
        masked,
        summary[:120],
    )
    await _notify_support_escalation(masked, reason, summary)
    if session is not None:
        try:
            from ..memory.postgres_store import persist_escalation_if_configured
            from ..workflow.hooks import schedule_workflow_event

            persist_escalation_if_configured(
                session,
                escalation_type="human_escalation",
                payload={"reason": reason, "summary": (summary or "")[:200]},
            )
            schedule_workflow_event(
                session,
                "escalation_created",
                {"type": "human_escalation", "reason": reason[:120]},
            )
        except Exception:
            pass
    return json.dumps({
        "escalated": True,
        "message": (
            "I've flagged this for our team. "
            "Someone will follow up with you shortly. "
            "Is there anything else I can help you with in the meantime?"
        ),
    })


# ── ElevenLabs-aligned tool wrappers (v4.2) ────────────────────────────────────


async def NormalizeVoiceIntent(
    text: str,
    context: str = "",
    session: Optional["SessionState"] = None,
) -> str:
    """ElevenLabs-aligned voice intent normalizer."""
    from .voice_intent import normalize_voice_intent

    return normalize_voice_intent(text, context=context)


async def CheckFacilityApproval(
    facility_name: str,
    order_number: Optional[str] = None,
    session: Optional["SessionState"] = None,
) -> str:
    """Check whether SureShot Books is approved to ship to a facility."""
    from ..facility.approval_worker import FacilityApprovalWorker
    from ..config import get_settings

    worker = FacilityApprovalWorker()
    entities: dict = {"facility_name": facility_name}
    if order_number:
        entities["order_number"] = order_number

    if session is None:
        return json.dumps({
            "approval_status": "unknown",
            "message": (
                "I don't have specific approval information for that facility on file. "
                "I'd recommend calling the facility to confirm, or I can forward this to customer service."
            ),
        })

    result = await worker.run(session, entities, get_settings())
    return json.dumps({
        "facility_name": facility_name,
        "approval_status": result.data.get("approval_status", "unknown") if result.data else "unknown",
        "message": result.safe_summary or "",
    })


async def CheckOrderFacilityRestrictions(
    order_number: Optional[str] = None,
    facility_name: Optional[str] = None,
    session: Optional["SessionState"] = None,
) -> str:
    """Check book restrictions — uses facility guideline documents + Shopify order."""
    if session and order_number:
        from ..facility.order_reconciliation import reconcile_order_facility_json

        return await reconcile_order_facility_json(
            session,
            order_number,
            facility_name or getattr(session, "last_facility_name", "") or "",
        )

    from ..facility.restriction_worker import FacilityRestrictionWorker
    from ..config import get_settings

    worker = FacilityRestrictionWorker()
    entities: dict = {}
    if order_number:
        entities["order_number"] = order_number
    if facility_name:
        entities["facility_name"] = facility_name

    if session is None:
        return json.dumps({
            "restrictions": [],
            "message": (
                "I need the order number and facility name to check which books "
                "may have been rejected. I can also share the facility's official "
                "mail-rules website when we have it on file."
            ),
        })

    result = await worker.run(session, entities, get_settings())
    return json.dumps({
        "facility_name": facility_name or getattr(session, "last_facility_name", ""),
        "restrictions": result.data.get("restrictions", []) if result.data else [],
        "message": result.safe_summary or "",
    })


async def AddressUpdateInstructions(
    order_number: Optional[str] = None,
    session: Optional["SessionState"] = None,
) -> str:
    """Return instructions for updating a shipping address."""
    settings = get_settings()
    jessica_email = settings.SUPPORT_EMAIL or "support@sureshotbooks.com"
    order_ref = f" for order {order_number}" if order_number else ""
    return json.dumps({
        "success": True,
        "instructions": (
            f"To update your shipping address{order_ref}, please email Jessica at {jessica_email}. "
            "Include your order number and the correct new address in your message. "
            "She will update it as quickly as possible."
        ),
        "contact_email": jessica_email,
    })


async def CancelOrderRequest(
    order_number: str,
    email: Optional[str] = None,
    session: Optional["SessionState"] = None,
) -> str:
    """Check cancellation eligibility for an order and initiate the request."""
    order_json = await lookup_order(
        order_number=order_number,
        email=email,
        phone=None,
        session=session,
    )
    order = json.loads(order_json)

    if not order.get("found"):
        return json.dumps({
            "success": False,
            "cancellation_eligible": False,
            "message": f"I couldn't find order {order_number}. Please double-check the order number.",
        })

    fulfillment = (order.get("fulfillment_status") or "").upper()
    status = (order.get("status") or "").upper()

    if fulfillment in ("FULFILLED", "PARTIALLY_FULFILLED"):
        return json.dumps({
            "success": True,
            "cancellation_eligible": False,
            "order_number": order.get("order_number", order_number),
            "fulfillment_status": fulfillment,
            "message": (
                "This order has already shipped, so it cannot be cancelled directly. "
                "I can forward this to customer service for the next steps."
            ),
        })

    if status in ("REFUNDED", "VOIDED"):
        return json.dumps({
            "success": True,
            "cancellation_eligible": False,
            "order_number": order.get("order_number", order_number),
            "message": f"This order already shows as {status.lower()}.",
        })

    return json.dumps({
        "success": True,
        "cancellation_eligible": True,
        "order_number": order.get("order_number", order_number),
        "fulfillment_status": fulfillment,
        "message": (
            "This order may be eligible for cancellation since it has not yet shipped. "
            "Customer service can process the cancellation request."
        ),
    })


async def EscalateToCustomerService(
    reason: str,
    summary: str = "",
    session: Optional["SessionState"] = None,
) -> str:
    """Escalate to a human customer service agent."""
    caller_phone = getattr(session, "from_number", "") if session else ""
    return await escalate_to_human(
        reason=reason,
        caller_phone=caller_phone,
        summary=summary,
        session=session,
    )


async def SendFacilityPaymentLink(
    email: str,
    order_number: Optional[str] = None,
    session: Optional["SessionState"] = None,
) -> str:
    """Send a secure facility/inmate payment link to the customer's email."""
    if not email or "@" not in email:
        return json.dumps({
            "success": False,
            "error": "A valid email address is required to send the secure link.",
        })

    settings = get_settings()
    from_addr = (
        f"{settings.RESEND_FROM_NAME} <{settings.RESEND_FROM_EMAIL}>"
        if settings.RESEND_FROM_NAME
        else settings.RESEND_FROM_EMAIL
    )
    order_ref = f"order {order_number}" if order_number else "your order"
    masked_email = _mask(email, show=2)

    logger.info(
        "SendFacilityPaymentLink email=%s order=%s",
        masked_email,
        order_number or "N/A",
    )

    if not settings.RESEND_API_KEY:
        return json.dumps({
            "success": False,
            "error": "Email service is not configured. Please contact customer service directly.",
        })

    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.post(
                "https://api.resend.com/emails",
                headers={
                    "Authorization": f"Bearer {settings.RESEND_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "from": from_addr,
                    "to": [email],
                    "subject": f"SureShot Books — Complete Your Facility Order",
                    "text": (
                        f"Hello,\n\n"
                        f"Thank you for calling SureShot Books. "
                        f"To complete {order_ref}, please follow the secure link below to provide "
                        f"facility details, inmate information, and payment.\n\n"
                        f"If you did not request this, please disregard this email.\n\n"
                        f"SureShot Books Customer Service"
                    ),
                },
            )
        if resp.status_code in (200, 201):
            return json.dumps({
                "success": True,
                "message": (
                    "I've sent the secure link to your email. "
                    "Please open it and complete the facility, inmate, and payment details. "
                    "You may also check spam or junk if you do not see it."
                ),
            })
        logger.warning("SendFacilityPaymentLink HTTP %s", resp.status_code)
        return json.dumps({
            "success": False,
            "error": "Could not send the link at this time. Please try again or contact customer service.",
        })
    except Exception:
        logger.exception("SendFacilityPaymentLink failed email=%s", masked_email)
        return json.dumps({
            "success": False,
            "error": "Could not send the link at this time. Please try again shortly.",
        })


async def SendPaymentLink(
    items: list[dict],
    email: str = "",
    customer_email: str = "",
    to_email: str = "",
    customer_name: Optional[str] = None,
    session: Optional["SessionState"] = None,
) -> str:
    """
    Create a Shopify payment link and email it — the combined flow for buying books.

    Call ONLY after: book confirmed, quantity confirmed, email confirmed by the customer.
    """
    from ..agent_runtime.payment_flow_state import (
        PAYMENT_FAILURE_MESSAGE,
        PAYMENT_SUCCESS_MESSAGE,
        build_payment_tool_result,
        gate_send_payment_link,
    )
    from ..payment.email_state import (
        assert_ready_for_payment_send,
        get_canonical_confirmed_email,
        log_payment_flow_diagnostics,
    )

    if session:
        log_payment_flow_diagnostics(session, stage="send_payment_link_start")
        gate = gate_send_payment_link(session, "")
        if not gate.allowed:
            return gate.tool_json
        if not assert_ready_for_payment_send(session, stage="send_payment_link_atomic"):
            return json.dumps(build_payment_tool_result(
                success=False,
                email_sent=False,
                customer_message=(
                    "I need a confirmed email address before I can send the payment link. "
                    "What email would you like me to use?"
                ),
                error_code="email_unconfirmed",
                retryable=True,
            ))

    confirmed = get_canonical_confirmed_email(session) if session else (
        (email or customer_email or to_email or "").strip().lower()
    )
    if not confirmed or "@" not in confirmed:
        return json.dumps(build_payment_tool_result(
            success=False,
            email_sent=False,
            customer_message=(
                "I need a confirmed email address before I can send the payment link. "
                "What email would you like me to use?"
            ),
            error_code="email_unconfirmed",
            retryable=True,
        ))

    if session:
        session.last_payment_attempt_status = "attempting"
    checkout_json = await create_checkout_link(
        items=items,
        email=confirmed,
        customer_name=customer_name,
        session=session,
    )
    checkout = json.loads(checkout_json)

    if not checkout.get("success"):
        return json.dumps(build_payment_tool_result(
            success=False,
            email_sent=False,
            customer_message=checkout.get("error") or PAYMENT_FAILURE_MESSAGE,
            error_code="checkout_failed",
            retryable=True,
            escalation_recommended=True,
        ))

    email_json = await send_payment_link_email_tool(
        email=confirmed,
        session=session,
    )
    email_result = json.loads(email_json)

    if email_result.get("success") and email_result.get("email_sent"):
        return json.dumps(build_payment_tool_result(
            success=True,
            email_sent=True,
            customer_message=email_result.get("customer_message") or PAYMENT_SUCCESS_MESSAGE,
            error_code="",
        ))

    session_status = "failed"
    if session:
        session.last_payment_attempt_status = session_status
    return json.dumps(build_payment_tool_result(
        success=False,
        email_sent=False,
        customer_message=email_result.get("customer_message") or PAYMENT_FAILURE_MESSAGE,
        error_code=email_result.get("error_code") or "email_send_failed",
        retryable=True,
        escalation_recommended=True,
    ))


async def GetCallerInfo(
    session: Optional["SessionState"] = None,
    *,
    allow_live: bool = True,
) -> str:
    """
    Return safe caller context.

    Recognises returning callers by phone number (friendly recognition only —
    never full verification, never private details from caller-ID alone).
    """
    if not session:
        return json.dumps({
            "caller_recognized": False,
            "message": "No session available.",
        })

    # Enrich from the caller-identity resolver (cache-first, optional live Shopify).
    identity: dict = {}
    phone = getattr(session, "from_number", "") or ""
    if phone:
        try:
            from ..agent_runtime.caller_identity import apply_to_session, get_caller_info

            identity = await get_caller_info(phone, allow_live=allow_live)
            apply_to_session(session, identity)
        except Exception as exc:  # noqa: BLE001
            logger.debug("GetCallerInfo identity enrichment skipped: %s", exc)

    caller_name = getattr(session, "caller_name", "") or identity.get("allowed_greeting_name", "")

    first_name = (
        identity.get("first_name", "")
        or (caller_name.split()[0] if caller_name else "")
    )
    recognized = bool(caller_name or identity.get("known"))
    recent = identity.get("recent_orders", []) or []

    return json.dumps({
        "recognized": recognized,
        "caller_recognized": recognized,
        "customer_first_name": first_name or None,
        "customer_id": (
            identity.get("customer_id", "")
            or getattr(session, "shopify_customer_id", "")
            or None
        ),
        "caller_name": caller_name or None,
        "phone_match_confidence": identity.get("phone_match_confidence", "low"),
        "recent_orders_summary_safe": recent,
        "verification_required_for_sensitive_details": True,
        # Verification flags reflect THIS call only — phone match is NOT verification.
        "verified_email": bool(getattr(session, "verified_email", False)),
        "verified_phone": bool(getattr(session, "verified_phone", False)),
        "last_order_number": getattr(session, "last_order_number", "") or None,
        "recent_orders": recent,
        "confirmed_email_masked": (
            _mask(session.confirmed_email)
            if getattr(session, "confirmed_email", "")
            else None
        ),
    })


async def SaveCallerName(
    name: str,
    session: Optional["SessionState"] = None,
) -> str:
    """Save the caller's name to their session."""
    if not name or not name.strip():
        return json.dumps({"success": False, "error": "Name cannot be empty."})

    clean_name = name.strip()[:100]

    if session:
        session.caller_name = clean_name
        logger.info("SaveCallerName sid=%s", session.call_sid[:6] if session.call_sid else "???")

    return json.dumps({
        "success": True,
        "name": clean_name,
        "message": f"Got it, thank you {clean_name}. How can I help you today?",
    })


async def SearchBookByISBN(isbn: str, session: Optional["SessionState"] = None) -> str:
    """
    Find a book by ISBN. The ISBN is checksum-validated first; partial fragments
    (e.g. "9780") are rejected so they can never return the wrong product.
    """
    from .isbn import extract_isbn_candidate, looks_like_isbn_fragment

    valid = extract_isbn_candidate(isbn or "")
    if not valid:
        if looks_like_isbn_fragment(isbn or ""):
            return json.dumps({
                "found": False,
                "needs_more_digits": True,
                "message": "That looks like a partial ISBN. Could you read the full ISBN, all 13 digits?",
            })
        return json.dumps({
            "found": False,
            "message": "That doesn't look like a complete ISBN. Could you read the full ISBN slowly?",
        })
    return await search_products(query=valid, limit=3)


async def SearchBookByTitle(title: str, limit: int = 5) -> str:
    """Find a book by title."""
    if not title or not title.strip():
        return json.dumps({"found": False, "message": "What is the title of the book?"})
    return await search_products(query=title.strip(), limit=limit)


async def SearchCustomerByPhone(
    phone: Optional[str] = None,
    session: Optional["SessionState"] = None,
) -> str:
    """Find a Shopify customer by phone (friendly recognition only — no PII)."""
    from ..agent_runtime.caller_identity import get_caller_info

    raw = phone or (getattr(session, "from_number", "") if session else "")
    if not raw:
        return json.dumps({"known": False, "message": "No phone number available."})
    info = await get_caller_info(raw)
    return json.dumps({
        "known": info["known"],
        "customer_id": info["customer_id"],
        "first_name": info["first_name"],
        "phone_match_confidence": info["phone_match_confidence"],
        "recent_orders": info["recent_orders"],
    })


async def SearchOrdersByPhone(
    phone: Optional[str] = None,
    session: Optional["SessionState"] = None,
) -> str:
    """Find recent orders for a caller's phone (safe summaries only)."""
    from ..agent_runtime.caller_identity import get_caller_info

    raw = phone or (getattr(session, "from_number", "") if session else "")
    if not raw:
        return json.dumps({"found": False, "message": "No phone number available."})
    info = await get_caller_info(raw)
    orders = info.get("recent_orders", [])
    return json.dumps({
        "found": bool(orders),
        "count": len(orders),
        "orders": orders,
    })


# ── Legacy aliases ────────────────────────────────────────────────────────────

async def SureShotCatalogSearch(query: str, limit: int = 5) -> str:
    """ElevenLabs-named alias for search_products with inventory enrichment."""
    raw = await search_products(query=query, limit=limit)
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return raw
    if isinstance(payload, dict):
        return json.dumps(_enrich_catalog_payload(payload))
    return raw


async def SureShotBooksSku(query: str) -> str:
    """Legacy: search by SKU/ISBN."""
    return await search_products(query=query, limit=3)


async def SureShotBooksProductFetcher(product_id_or_handle: str) -> str:
    """Legacy: fetch full product details."""
    return await get_product_details(product_id_or_handle=product_id_or_handle)


async def SureShotBooksProduct(query: str, limit: int = 5) -> str:
    """Legacy: search by keyword."""
    return await search_products(query=query, limit=limit)


async def CalculatePricing(
    order_number: Optional[str] = None,
    email: Optional[str] = None,
    phone: Optional[str] = None,
    session: Optional["SessionState"] = None,
) -> str:
    """Retrieve pricing and shipping details — alias for lookup_order focused on pricing."""
    result_json = await lookup_order(
        order_number=order_number,
        email=email,
        phone=phone,
        session=session,
    )
    result = json.loads(result_json)
    if not result.get("found"):
        return result_json

    # Filter to pricing-relevant fields only
    pricing = {
        "found": True,
        "order_number": result.get("order_number"),
        "subtotal": result.get("subtotal"),
        "shipping": result.get("shipping"),
        "total": result.get("total"),
        "items": result.get("items"),
        "note": "Subtotal is before shipping. Subtotal does not include shipping.",
    }
    return json.dumps(pricing)


async def GetOrder(
    order_number: Optional[str] = None,
    email: Optional[str] = None,
    phone: Optional[str] = None,
    session: Optional["SessionState"] = None,
) -> str:
    """ElevenLabs-named alias for lookup_order. Includes order details and refund info."""
    return await lookup_order(
        order_number=order_number,
        email=email,
        phone=phone,
        session=session,
    )
