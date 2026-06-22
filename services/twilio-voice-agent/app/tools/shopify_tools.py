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

        # Gate on confirmed cart when session is present
        cart_result = require_confirmed_cart(session)
        if not cart_result.allowed:
            logger.info(
                "payment_tool_result tool=create_checkout_link allowed=false "
                "reason=%s missing=%s",
                cart_result.reason, cart_result.missing_fields,
            )
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
        logger.info(
            "payment_tool_result tool=send_payment_link_email allowed=false "
            "reason=%s missing=%s",
            ready_result.reason, ready_result.missing_fields,
        )
        return json.dumps({"success": False, "error": ready_result.safe_message})

    # Validate LLM-supplied email arg against confirmed_email
    arg_result = validate_tool_email_arg(email or None, session)
    if not arg_result.allowed:
        logger.info(
            "payment_tool_result tool=send_payment_link_email allowed=false "
            "reason=%s",
            arg_result.reason,
        )
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
        logger.info(
            "payment_tool_result tool=send_payment_link_email allowed=true "
            "email=%s",
            arg_result.confirmed_email_masked or "***",
        )
        # Advance payment flow status
        if hasattr(session, "payment_flow_status"):
            session.payment_flow_status = "payment_sent"

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


# ── ElevenLabs-aligned tool wrappers (v4.2) ────────────────────────────────────


async def CheckFacilityApproval(
    facility_name: str,
    order_number: Optional[str] = None,
    session: Optional["SessionState"] = None,
) -> str:
    """Check whether SureShot Books is approved to ship to a facility."""
    from ..workers.facility_approval_worker import FacilityApprovalWorker
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
    """Check book restrictions for a correctional facility on a specific order."""
    from ..workers.facility_restriction_worker import FacilityRestrictionWorker
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
                "I don't have specific restriction information on file for that facility. "
                "Common restrictions include: no hardcover books, new books only, and books must "
                "ship directly from the retailer. I'd recommend calling the facility to confirm."
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
    email: str,
    customer_name: Optional[str] = None,
    session: Optional["SessionState"] = None,
) -> str:
    """
    Create a Shopify payment link and email it — the combined flow for buying books.

    Call ONLY after: book confirmed, quantity confirmed, email confirmed by the customer.
    """
    if not email or "@" not in email:
        return json.dumps({
            "success": False,
            "error": (
                "I need a confirmed email address before I can create and send the payment link. "
                "What email would you like me to use?"
            ),
        })

    # Step 1: create the checkout link
    checkout_json = await create_checkout_link(
        items=items,
        email=email,
        customer_name=customer_name,
        session=session,
    )
    checkout = json.loads(checkout_json)

    if not checkout.get("success"):
        return json.dumps(checkout)

    # Step 2: email it
    email_json = await send_payment_link_email_tool(email=email, session=session)
    email_result = json.loads(email_json)

    if email_result.get("success"):
        return json.dumps({
            "success": True,
            "order_name": checkout.get("order_name"),
            "message": (
                "I've sent the payment link to your email. "
                "Please check your inbox — and your spam folder if you don't see it. "
                "Click the link to complete your purchase securely."
            ),
        })

    # Checkout created but email failed — still useful
    return json.dumps({
        "success": False,
        "checkout_created": True,
        "order_name": checkout.get("order_name"),
        "checkout_url": checkout.get("checkout_url"),
        "error": (
            "I created your payment link but had trouble sending the email. "
            "Please try again or let me forward this to customer service."
        ),
    })


async def GetCallerInfo(
    session: Optional["SessionState"] = None,
) -> str:
    """Return safe caller context from the current session."""
    if not session:
        return json.dumps({
            "caller_recognized": False,
            "message": "No session available.",
        })

    return json.dumps({
        "caller_recognized": bool(getattr(session, "caller_name", "")),
        "caller_name": getattr(session, "caller_name", "") or None,
        "verified_email": bool(getattr(session, "verified_email", False)),
        "verified_phone": bool(getattr(session, "verified_phone", False)),
        "last_order_number": getattr(session, "last_order_number", "") or None,
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


# ── Legacy aliases ────────────────────────────────────────────────────────────

async def SureShotCatalogSearch(query: str, limit: int = 5) -> str:
    """ElevenLabs-named alias for search_products."""
    return await search_products(query=query, limit=limit)


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
