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
from .isbn import normalize_isbn
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


async def search_products(query: str, limit: int = 5) -> str:
    """
    Search Shopify catalog.

    Cache-first order:
      1. ProductCache: ISBN index (if query looks like an ISBN)
      2. ProductCache: exact title match
      3. ProductCache: handle match
      4. Redis search-result cache (shopify_cache_get)
      5. Shopify live API (barcode lookup for ISBNs, then title search)
    """
    limit = max(1, min(10, limit))
    settings = get_settings()

    # ── 1-3. ProductCache lookups (Redis, sub-ms) ──────────────────────────────
    try:
        from ..sync.repositories import ProductCache
        pc = ProductCache()

        isbn = normalize_isbn(query)
        if isbn:
            cached_product = await pc.get_by_isbn(isbn)
            if cached_product:
                logger.debug("ProductCache ISBN hit: %s", isbn)
                payload = {
                    "results": [_cached_product_to_result(cached_product)],
                    "count": 1,
                    "source": "cache",
                }
                return json.dumps(payload)

        cached_product = await pc.get_by_title(query)
        if cached_product:
            logger.debug("ProductCache title hit: %r", query)
            payload = {
                "results": [_cached_product_to_result(cached_product)],
                "count": 1,
                "source": "cache",
            }
            return json.dumps(payload)

        handle = query.lower().strip().replace(" ", "-")
        cached_product = await pc.get_by_handle(handle)
        if cached_product:
            logger.debug("ProductCache handle hit: %r", handle)
            payload = {
                "results": [_cached_product_to_result(cached_product)],
                "count": 1,
                "source": "cache",
            }
            return json.dumps(payload)
    except Exception as exc:
        logger.debug("ProductCache lookup skipped: %s", exc)

    # ── 4. Redis search-result cache ───────────────────────────────────────────
    cache_key = f"search:{query.lower().strip()}:{limit}"
    cached = await shopify_cache_get(cache_key)
    if cached is not None:
        logger.debug("Shopify search cache hit: %s", query)
        return json.dumps(cached)

    client = get_shopify_client()
    if not client.configured:
        return json.dumps({"error": "Shopify not configured", "results": []})

    # ── 5. Live Shopify API ────────────────────────────────────────────────────
    isbn = normalize_isbn(query)
    if isbn:
        isbn_result = await _search_by_isbn(isbn, limit)
        if isbn_result and isbn_result.get("count", 0) > 0:
            await shopify_cache_set(cache_key, isbn_result, ttl=settings.SHOPIFY_CACHE_TTL_SECS)
            return json.dumps(isbn_result)

    try:
        data = await client.execute(
            SEARCH_PRODUCTS,
            variables={"query": query, "first": limit},
        )
        edges = data.get("data", {}).get("products", {}).get("edges", [])
        results = [_normalise_product(e["node"]) for e in edges]
        payload = {"results": results, "count": len(results)}
        await shopify_cache_set(cache_key, payload, ttl=settings.SHOPIFY_CACHE_TTL_SECS)
        return json.dumps(payload)
    except Exception as exc:
        logger.error("search_products failed: %s", exc)
        return json.dumps({"error": "Shopify search temporarily unavailable.", "results": []})


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
        if not phone and session.verified_phone:
            phone = session.from_number

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

        result: dict = {
            "found": True,
            "order_number": node["name"],
            "status": node["displayFinancialStatus"],
            "fulfillment_status": node["displayFulfillmentStatus"],
        }

        if verified:
            result["items"] = [
                f"{e['node']['quantity']}x {e['node']['title']}"
                for e in node.get("lineItems", {}).get("edges", [])
            ]
            subtotal = node.get("subtotalPriceSet", {}).get("shopMoney", {})
            result["subtotal"] = f"{subtotal.get('amount', '?')} {subtotal.get('currencyCode', '')}"
            shipping = node.get("totalShippingPriceSet", {}).get("shopMoney", {})
            result["shipping"] = f"{shipping.get('amount', '?')} {shipping.get('currencyCode', '')}"
            tracking = (node.get("fulfillments") or [{}])[0]
            tracking_info = (tracking.get("trackingInfo") or [{}])[0] if tracking else {}
            result["tracking_number"] = tracking_info.get("number")
            result["tracking_url"] = tracking_info.get("url")
            if session:
                session.verified_email = bool(email)
                session.verified_phone = bool(phone)

        return json.dumps(result)

    except Exception as exc:
        logger.error("lookup_order failed: %s", exc)
        return json.dumps({"error": "Order lookup temporarily unavailable."})


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
            refund_summaries.append({
                "date": (r.get("createdAt") or "")[:10],
                "amount": f"{total.get('amount', '?')} {total.get('currencyCode', '')}",
                "items": items,
                "refunded_via": gateways,
            })

        return json.dumps({
            "found": True,
            "order_number": order_node["name"],
            "refund_count": len(refund_summaries),
            "refunds": refund_summaries,
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
        # Gate on confirmed cart when session is present
        cart_result = require_confirmed_cart(session)
        if not cart_result.allowed:
            return json.dumps({"success": False, "error": cart_result.safe_message})

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

        # Resolve email: prefer confirmed_email; if LLM passed one, validate it
        confirmed_email = getattr(session, "confirmed_email", "") or ""
        if email and email.strip():
            arg_result = validate_tool_email_arg(email, session)
            if not arg_result.allowed and arg_result.reason == "rejected_candidate":
                return json.dumps({"success": False, "error": arg_result.safe_message})
            # Non-rejected mismatch: ignore LLM arg, use confirmed_email (don't block checkout)
            email = confirmed_email or None
        elif confirmed_email:
            email = confirmed_email

    try:
        line_items = [
            {"variantId": item["variant_id"], "quantity": item.get("quantity", 1)}
            for item in items
        ]
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

        return json.dumps({
            "success": True,
            "order_name": draft_id,
            "checkout_url": checkout_url,
            "message": "Payment link created. Shall I email it to you?",
        })

    except Exception as exc:
        logger.error("create_checkout_link failed: %s", exc)
        return json.dumps({"success": False, "error": "Could not create checkout link at this time."})


async def send_payment_link_email_tool(
    email: str,
    session: Optional["SessionState"] = None,
) -> str:
    """
    Email the pending checkout link to the caller.

    Safety: enforces confirmed_email via PaymentSafetyGuard. Raw LLM email arg is
    validated against session.confirmed_email; rejected candidates are hard-blocked.
    Never sends to pending_email or unconfirmed addresses.
    """
    from ..payment.safety import validate_tool_email_arg, require_payment_send_ready

    if not session:
        # No session — cannot enforce confirmed_email; refuse send
        return json.dumps({
            "success": False,
            "error": "No session available. Cannot verify email address.",
        })

    # Full payment send gate: confirmed_email + checkout_url
    ready_result = require_payment_send_ready(session)
    if not ready_result.allowed:
        return json.dumps({"success": False, "error": ready_result.safe_message})

    # Validate LLM-supplied email arg against confirmed_email
    arg_result = validate_tool_email_arg(email or None, session)
    if not arg_result.allowed:
        return json.dumps({"success": False, "error": arg_result.safe_message})

    # Use confirmed_email from session — never the raw LLM arg
    confirmed_email = session.confirmed_email

    if confirmed_email in session.payment_email_sent_to:
        return json.dumps({
            "success": True,
            "duplicate": True,
            "message": "I already sent the payment link to your email during this call.",
        })

    result = await send_payment_link_email(
        email=confirmed_email,
        checkout_url=session.pending_checkout_url,
        product_summary=session.last_product_title or "your selected items",
        caller_name=session.caller_name or None,
        order_or_draft_id=session.pending_draft_order_id or None,
    )

    if result.get("success"):
        session.payment_email_sent_to.append(confirmed_email)

    return json.dumps(result)


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
    return json.dumps({
        "escalated": True,
        "message": (
            "I've flagged this for our team. "
            "Someone will follow up with you shortly. "
            "Is there anything else I can help you with in the meantime?"
        ),
    })
