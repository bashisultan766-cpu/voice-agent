"""
Async Shopify Admin REST API client (v2024-01).

Design:
- One `ShopifyAdminClient` instance per (domain, token) pair, cached module-level.
- All I/O through httpx.AsyncClient as a context manager (no shared socket state).
- Retries once on transient errors (5xx, connection reset).
- Hard timeout: 8 s per request (voice call budget).
- Returns clean domain dicts — callers map to Pydantic models themselves.

Usage:
    client = get_shopify_client(domain, access_token)
    order = await client.get_order("1234")
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)

_API_VERSION = "2024-01"
_TIMEOUT = httpx.Timeout(8.0, connect=3.0)
_MAX_RETRIES = 1


class ShopifyAdminClient:
    """Thin async wrapper over the Shopify Admin REST API."""

    def __init__(self, domain: str, access_token: str) -> None:
        self._base = f"https://{domain.rstrip('/')}/admin/api/{_API_VERSION}"
        self._headers = {
            "X-Shopify-Access-Token": access_token,
            "Content-Type": "application/json",
        }

    # ── Internal helpers ───────────────────────────────────────────────────────

    async def _get(self, path: str, params: dict | None = None) -> dict:
        url = f"{self._base}{path}"
        for attempt in range(_MAX_RETRIES + 1):
            try:
                async with httpx.AsyncClient(timeout=_TIMEOUT) as http:
                    r = await http.get(url, headers=self._headers, params=params)
                if r.status_code == 429:
                    retry_after = float(r.headers.get("Retry-After", "2"))
                    await asyncio.sleep(min(retry_after, 4.0))
                    continue
                r.raise_for_status()
                return r.json()
            except httpx.HTTPStatusError as exc:
                if attempt == _MAX_RETRIES:
                    raise
                logger.warning("Shopify GET %s → %s, retrying", path, exc.response.status_code)
            except httpx.RequestError as exc:
                if attempt == _MAX_RETRIES:
                    raise
                logger.warning("Shopify GET %s → network error: %s, retrying", path, exc)
        return {}

    async def _post(self, path: str, body: dict) -> dict:
        url = f"{self._base}{path}"
        for attempt in range(_MAX_RETRIES + 1):
            try:
                async with httpx.AsyncClient(timeout=_TIMEOUT) as http:
                    r = await http.post(url, headers=self._headers, json=body)
                if r.status_code == 429:
                    await asyncio.sleep(2.0)
                    continue
                r.raise_for_status()
                return r.json()
            except httpx.HTTPStatusError as exc:
                if attempt == _MAX_RETRIES:
                    raise
                logger.warning("Shopify POST %s → %s, retrying", path, exc.response.status_code)
            except httpx.RequestError as exc:
                if attempt == _MAX_RETRIES:
                    raise
                logger.warning("Shopify POST %s → network error: %s, retrying", path, exc)
        return {}

    # ── Public API ─────────────────────────────────────────────────────────────

    async def get_order(self, order_number: str) -> Optional[dict[str, Any]]:
        """
        Fetch a single order by its display number (e.g. '1234' or '#1234').
        Returns the raw Shopify order dict or None if not found.
        """
        try:
            data = await self._get(
                "/orders.json",
                params={
                    "name": f"#{order_number}",
                    "status": "any",
                    "limit": 1,
                    "fields": (
                        "id,name,order_number,financial_status,fulfillment_status,"
                        "line_items,shipping_lines,shipping_address,"
                        "subtotal_price,total_price,cancel_reason,"
                        "cancelled_at,created_at,fulfillments,tags"
                    ),
                },
            )
            orders = data.get("orders", [])
            return orders[0] if orders else None
        except Exception as exc:
            logger.error("get_order(%s) failed: %s", order_number, exc)
            raise

    async def search_products(
        self,
        query: str,
        search_type: str = "general",
        limit: int = 5,
    ) -> list[dict[str, Any]]:
        """
        Search products by title (general/title), vendor (author), or tag (isbn).
        Returns a list of raw Shopify product dicts.
        """
        fields = "id,title,vendor,tags,variants,images,status"
        try:
            if search_type == "author":
                data = await self._get(
                    "/products.json",
                    params={"vendor": query, "limit": limit, "fields": fields},
                )
            elif search_type == "isbn":
                # ISBN maps to SKU or barcode on variants — search via title tag fallback
                data = await self._get(
                    "/products.json",
                    params={"title": query, "limit": limit, "fields": fields},
                )
            else:
                data = await self._get(
                    "/products.json",
                    params={"title": query, "limit": limit, "fields": fields},
                )
            return data.get("products", [])
        except Exception as exc:
            logger.error("search_products(%r) failed: %s", query, exc)
            raise

    async def get_variant(self, variant_id: str) -> Optional[dict[str, Any]]:
        """Fetch a single product variant by ID."""
        try:
            data = await self._get(f"/variants/{variant_id}.json")
            return data.get("variant")
        except Exception as exc:
            logger.error("get_variant(%s) failed: %s", variant_id, exc)
            raise

    async def create_draft_order(
        self,
        email: str,
        items: list[dict],
        customer_phone: Optional[str] = None,
        note: Optional[str] = None,
        tags: Optional[str] = None,
    ) -> dict[str, Any]:
        """
        Create a Shopify draft order and return its raw dict.
        Items: [{"variant_id": "...", "quantity": 1}]
        """
        line_items = [
            {"variant_id": item["variant_id"], "quantity": item.get("quantity", 1)}
            for item in items
        ]
        payload: dict[str, Any] = {
            "draft_order": {
                "line_items": line_items,
                "email": email,
                "use_customer_default_address": False,
            }
        }
        if customer_phone:
            payload["draft_order"]["phone"] = customer_phone
        if note:
            payload["draft_order"]["note"] = note
        if tags:
            payload["draft_order"]["tags"] = tags

        try:
            data = await self._post("/draft_orders.json", payload)
            return data.get("draft_order", {})
        except Exception as exc:
            logger.error("create_draft_order failed: %s", exc)
            raise

    async def cancel_order(
        self,
        order_id: str,
        reason: str = "customer",
        amount: Optional[str] = None,
    ) -> dict[str, Any]:
        """
        Cancel an order. reason: 'customer' | 'inventory' | 'fraud' | 'declined' | 'other'.
        Returns the updated order dict or raises on failure.
        """
        body: dict[str, Any] = {"reason": reason, "email": True}
        if amount:
            body["amount"] = amount
            body["currency"] = "USD"
        try:
            data = await self._post(f"/orders/{order_id}/cancel.json", body)
            return data.get("order", {})
        except Exception as exc:
            logger.error("cancel_order(%s) failed: %s", order_id, exc)
            raise


# ── Module-level client cache ─────────────────────────────────────────────────

_client_cache: dict[str, ShopifyAdminClient] = {}


def get_shopify_client(domain: str, access_token: str) -> ShopifyAdminClient:
    """
    Return a cached ShopifyAdminClient for the given domain.
    One instance per tenant — safe for concurrent async use.
    """
    key = f"{domain}:{access_token[:8]}"
    if key not in _client_cache:
        _client_cache[key] = ShopifyAdminClient(domain, access_token)
    return _client_cache[key]
