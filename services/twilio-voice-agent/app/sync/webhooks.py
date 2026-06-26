"""
Shopify webhook handlers and admin sync endpoint.

Endpoints:
  POST /webhooks/shopify/products    — product create/update/delete
  POST /webhooks/shopify/orders      — order create/update
  POST /webhooks/shopify/customers   — customer create/update
  POST /webhooks/shopify/refunds     — refund create (updates order cache)
  POST /admin/sync                   — trigger full sync (INTERNAL_ADMIN_KEY required)

All webhook handlers:
  1. Verify X-Shopify-Hmac-SHA256 against SHOPIFY_WEBHOOK_SECRET.
  2. Return 200 immediately.
  3. Process the payload in a background task (asyncio.create_task).

The admin sync endpoint is protected by the X-Admin-Key header.
SHOPIFY_WEBHOOK_SECRET and INTERNAL_ADMIN_KEY must never be logged.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from ..config import get_settings
from ..security.rate_limit import rate_limit_dependency
from ..sync.shopify_sync import sync_shopify_store

logger = logging.getLogger(__name__)

webhooks_router = APIRouter(tags=["webhooks"])
admin_router = APIRouter(tags=["admin"])


# ── HMAC verification ──────────────────────────────────────────────────────────

def verify_shopify_hmac(body: bytes, signature_b64: str, secret: str) -> bool:
    """
    Verify a Shopify webhook HMAC-SHA256 signature.

    Shopify signs the raw request body with the webhook secret and sends
    the base64-encoded digest in X-Shopify-Hmac-SHA256.
    """
    if not secret or not signature_b64:
        return False
    digest = hmac.new(secret.encode(), body, hashlib.sha256).digest()
    expected = base64.b64encode(digest).decode()
    return hmac.compare_digest(expected, signature_b64)


def _require_hmac(body: bytes, headers, secret: str) -> None:
    """Raise HTTP 401 if HMAC verification fails."""
    if not secret:
        # Webhook secret not configured — skip validation (dev mode only).
        logger.warning("SHOPIFY_WEBHOOK_SECRET not set — skipping HMAC validation")
        return
    sig = headers.get("x-shopify-hmac-sha256", "")
    if not verify_shopify_hmac(body, sig, secret):
        raise HTTPException(status_code=401, detail="Invalid webhook signature")


# ── Product webhooks ───────────────────────────────────────────────────────────

@webhooks_router.post("/webhooks/shopify/products")
async def product_webhook(request: Request) -> Response:
    """Handle products/create, products/update, products/delete."""
    body = await request.body()
    settings = get_settings()
    _require_hmac(body, request.headers, settings.SHOPIFY_WEBHOOK_SECRET)

    topic = request.headers.get("x-shopify-topic", "")
    try:
        payload = json.loads(body)
    except Exception:
        logger.warning("Product webhook: invalid JSON body")
        return Response(status_code=200)

    asyncio.create_task(
        _process_product(payload, topic),
        name="wh-product",
    )
    return Response(status_code=200)


async def _process_product(payload: dict, topic: str) -> None:
    from ..sync.repositories import ProductCache, CachedProduct
    cache = ProductCache()
    product_id = payload.get("id", "")
    if not product_id:
        return

    gid = f"gid://shopify/Product/{product_id}"

    if "delete" in topic.lower():
        await cache.delete(gid)
        logger.info("Product cache: deleted id=%s", product_id)
        return

    title = payload.get("title", "")
    handle = payload.get("handle", "")
    isbn = ""
    author = ""
    variant_id = ""
    price = ""
    available = False

    for variant in (payload.get("variants") or [])[:1]:
        variant_id = f"gid://shopify/ProductVariant/{variant.get('id', '')}"
        price = str(variant.get("price", ""))
        available = variant.get("inventory_management") != "shopify" or bool(
            variant.get("inventory_quantity", 0)
        )
        for src in (variant.get("barcode") or "", variant.get("sku") or ""):
            digits = "".join(c for c in src if c.isdigit())
            if len(digits) in (10, 13):
                isbn = digits
                break

    for tag in (payload.get("tags") or "").split(","):
        tag = tag.strip()
        if tag.lower().startswith("isbn"):
            isbn = "".join(c for c in tag if c.isdigit())
            if len(isbn) not in (10, 13):
                isbn = ""
            break

    product = CachedProduct(
        product_id=gid,
        title=title,
        handle=handle,
        isbn=isbn,
        author=author,
        variant_id=variant_id,
        price=price,
        available=available,
    )
    await cache.set(product)
    logger.info("Product cache: upserted id=%s title=%r isbn=%r", product_id, title[:40], isbn)


# ── Order webhooks ─────────────────────────────────────────────────────────────

@webhooks_router.post("/webhooks/shopify/orders")
async def order_webhook(request: Request) -> Response:
    """Handle orders/create, orders/updated."""
    body = await request.body()
    settings = get_settings()
    _require_hmac(body, request.headers, settings.SHOPIFY_WEBHOOK_SECRET)

    try:
        payload = json.loads(body)
    except Exception:
        return Response(status_code=200)

    asyncio.create_task(_process_order(payload), name="wh-order")
    return Response(status_code=200)


@webhooks_router.post("/webhooks/shopify/refunds")
async def refund_webhook(request: Request) -> Response:
    """Handle refunds/create — updates the order cache with current refund count."""
    body = await request.body()
    settings = get_settings()
    _require_hmac(body, request.headers, settings.SHOPIFY_WEBHOOK_SECRET)

    try:
        payload = json.loads(body)
    except Exception:
        return Response(status_code=200)

    asyncio.create_task(_process_refund(payload), name="wh-refund")
    return Response(status_code=200)


async def _process_order(payload: dict) -> None:
    from ..sync.repositories import OrderCache, CachedOrder
    from ..caller.repository import mask_email, normalize_phone
    cache = OrderCache()
    try:
        order_id = f"gid://shopify/Order/{payload.get('id', '')}"
        order_number = payload.get("name", "")
        customer = payload.get("customer") or {}
        customer_id = f"gid://shopify/Customer/{customer.get('id', '')}" if customer.get("id") else ""
        phone = customer.get("phone") or payload.get("phone") or ""
        email = customer.get("email") or payload.get("email") or ""
        norm_phone = normalize_phone(phone)
        email_masked = mask_email(email) if email else ""

        financial_status = payload.get("financial_status", "")
        fulfillment_status = payload.get("fulfillment_status") or ""
        refund_count = len(payload.get("refunds") or [])

        items = [
            f"{li.get('quantity', 1)}x {li.get('title', '')}"
            for li in (payload.get("line_items") or [])[:3]
        ]
        line_items_summary = ", ".join(items)

        tracking_parts = []
        for f in payload.get("fulfillments") or []:
            for t in f.get("tracking_numbers") or []:
                tracking_parts.append(t)
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
            logger.info("Order cache: upserted #%s phone_tail=%s", order_number, norm_phone[-4:] if norm_phone else "?")
    except Exception as exc:
        logger.warning("Order webhook processing error: %s", exc)


async def _process_refund(payload: dict) -> None:
    """
    Update the cached order's refund count when a new refund is created.

    Shopify refund webhooks include ``order_id`` as a numeric database ID
    (e.g. 987654321), NOT the display order name (e.g. #1042). We try the
    display name first (``order_name`` / ``name`` fields), then fall back to
    a GID lookup so we can always find the cached order.
    """
    from ..sync.repositories import OrderCache
    cache = OrderCache()
    try:
        existing = None

        # 1. Try display order name if present in payload.
        order_name = (
            payload.get("order_name")
            or payload.get("name")
            or payload.get("order_number")
            or ""
        )
        if order_name:
            existing = await cache.get_by_number(str(order_name))

        # 2. Fall back to Shopify numeric order ID → GID lookup.
        if not existing:
            order_id_raw = payload.get("order_id")
            if order_id_raw:
                existing = await cache.get_by_shopify_id(str(order_id_raw))

        if existing:
            existing.refund_count += 1
            await cache.set(existing)
            logger.info("Order cache: refund +1 for %s", existing.order_number)
        else:
            logger.debug(
                "Refund webhook: no cached order found (payload keys=%s)",
                list(payload.keys()),
            )
    except Exception as exc:
        logger.warning("Refund webhook processing error: %s", exc)


# ── Customer webhooks ──────────────────────────────────────────────────────────

@webhooks_router.post("/webhooks/shopify/customers")
async def customer_webhook(request: Request) -> Response:
    """Handle customers/create, customers/update."""
    body = await request.body()
    settings = get_settings()
    _require_hmac(body, request.headers, settings.SHOPIFY_WEBHOOK_SECRET)

    try:
        payload = json.loads(body)
    except Exception:
        return Response(status_code=200)

    asyncio.create_task(_process_customer(payload), name="wh-customer")
    return Response(status_code=200)


async def _process_customer(payload: dict) -> None:
    from ..sync.repositories import CustomerCache, CachedCustomer
    from ..caller.repository import mask_email, normalize_phone
    cache = CustomerCache()
    try:
        customer_id = f"gid://shopify/Customer/{payload.get('id', '')}"
        first = payload.get("first_name") or ""
        last = payload.get("last_name") or ""
        display_name = f"{first} {last}".strip()
        phone = payload.get("phone") or payload.get("default_address", {}).get("phone", "")
        email = payload.get("email") or ""
        norm_phone = normalize_phone(phone)
        email_masked = mask_email(email) if email else ""

        if customer_id and norm_phone:
            await cache.set(CachedCustomer(
                customer_id=customer_id,
                normalized_phone=norm_phone,
                display_name=display_name,
                email_masked=email_masked,
            ))
            logger.info("Customer cache: upserted id=%s phone_tail=%s", customer_id[-6:], norm_phone[-4:])
    except Exception as exc:
        logger.warning("Customer webhook processing error: %s", exc)


# ── Admin sync trigger ─────────────────────────────────────────────────────────

@admin_router.post(
    "/admin/sync",
    dependencies=[Depends(rate_limit_dependency("admin_sync", limit=10, window_sec=60))],
)
async def trigger_sync(request: Request) -> dict:
    """
    Trigger a full Shopify sync in the background.
    Protected by the X-Admin-Key header matching INTERNAL_ADMIN_KEY.
    """
    settings = get_settings()
    admin_key = settings.INTERNAL_ADMIN_KEY
    if not admin_key:
        raise HTTPException(status_code=403, detail="Admin sync not configured")
    provided = request.headers.get("x-admin-key", "")
    if not hmac.compare_digest(provided, admin_key):
        raise HTTPException(status_code=403, detail="Forbidden")

    asyncio.create_task(sync_shopify_store(), name="admin-full-sync")
    logger.info("Admin: full Shopify sync triggered")
    return {"status": "sync started"}
