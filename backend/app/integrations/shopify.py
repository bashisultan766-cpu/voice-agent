from __future__ import annotations
import asyncio
from typing import Any, Dict, List, Optional
import httpx
from app.config import settings
from app.core.cache import cache_get, cache_set


class ShopifyClient:
    """Async Shopify Admin API client with caching and retry logic."""

    API_VERSION = "2024-10"

    def __init__(self, store_url: str, api_token: str):
        self.store_url = store_url.rstrip("/")
        self.api_token = api_token
        self._client: Optional[httpx.AsyncClient] = None

    def _base(self) -> str:
        return f"{self.store_url}/admin/api/{self.API_VERSION}"

    def _headers(self) -> Dict[str, str]:
        return {
            "X-Shopify-Access-Token": self.api_token,
            "Content-Type": "application/json",
        }

    async def _get(self, path: str, params: Optional[Dict] = None) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=8.0) as client:
            for attempt in range(3):
                try:
                    r = await client.get(
                        f"{self._base()}{path}",
                        headers=self._headers(),
                        params=params or {},
                    )
                    r.raise_for_status()
                    return r.json()
                except httpx.HTTPStatusError as e:
                    if e.response.status_code == 429:
                        await asyncio.sleep(0.5 * (attempt + 1))
                        continue
                    raise
                except httpx.RequestError:
                    if attempt == 2:
                        raise
                    await asyncio.sleep(0.3)
            return {}

    async def _post(self, path: str, body: Dict[str, Any]) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(
                f"{self._base()}{path}",
                headers=self._headers(),
                json=body,
            )
            r.raise_for_status()
            return r.json()

    # ── Product search ────────────────────────────────────────────────────────

    async def search_products(self, query: str, limit: int = 10) -> List[Dict[str, Any]]:
        cache_key = f"shopify:search:{self.store_url}:{query}:{limit}"
        cached = await cache_get(cache_key)
        if cached is not None:
            return cached

        data = await self._get("/products.json", params={"title": query, "limit": limit})
        products = data.get("products", [])

        # Flatten to lightweight dicts
        results = [
            {
                "id": p["id"],
                "title": p["title"],
                "handle": p["handle"],
                "product_type": p.get("product_type", ""),
                "vendor": p.get("vendor", ""),
                "price": p["variants"][0]["price"] if p.get("variants") else "0.00",
                "available": any(v.get("available", False) for v in p.get("variants", [])),
                "image": p["images"][0]["src"] if p.get("images") else None,
                "body_html": p.get("body_html", "")[:300],
                "variants": [
                    {
                        "id": v["id"],
                        "title": v["title"],
                        "price": v["price"],
                        "available": v.get("available", False),
                        "sku": v.get("sku", ""),
                    }
                    for v in p.get("variants", [])[:5]
                ],
            }
            for p in products
        ]

        await cache_set(cache_key, results, ttl=settings.SHOPIFY_CACHE_TTL)
        return results

    async def get_product(self, product_id: str) -> Optional[Dict[str, Any]]:
        cache_key = f"shopify:product:{self.store_url}:{product_id}"
        cached = await cache_get(cache_key)
        if cached is not None:
            return cached

        data = await self._get(f"/products/{product_id}.json")
        product = data.get("product")
        if product:
            await cache_set(cache_key, product, ttl=settings.SHOPIFY_CACHE_TTL)
        return product

    # ── Order lookup ─────────────────────────────────────────────────────────

    async def get_order_by_name(self, order_name: str) -> Optional[Dict[str, Any]]:
        data = await self._get("/orders.json", params={"name": order_name, "limit": 1, "status": "any"})
        orders = data.get("orders", [])
        return orders[0] if orders else None

    async def get_orders_by_email(self, email: str, limit: int = 5) -> List[Dict[str, Any]]:
        data = await self._get("/orders.json", params={"email": email, "limit": limit, "status": "any"})
        return data.get("orders", [])

    # ── Customer lookup ───────────────────────────────────────────────────────

    async def get_customer_by_email(self, email: str) -> Optional[Dict[str, Any]]:
        cache_key = f"shopify:customer:{self.store_url}:{email}"
        cached = await cache_get(cache_key)
        if cached is not None:
            return cached

        data = await self._get("/customers/search.json", params={"query": f"email:{email}", "limit": 1})
        customers = data.get("customers", [])
        result = customers[0] if customers else None
        if result:
            await cache_set(cache_key, result, ttl=30)
        return result

    # ── Draft order / checkout ────────────────────────────────────────────────

    async def create_draft_order(
        self,
        line_items: List[Dict[str, Any]],
        customer_email: str,
        note: str = "",
    ) -> Dict[str, Any]:
        body = {
            "draft_order": {
                "line_items": line_items,
                "email": customer_email,
                "note": note,
                "use_customer_default_address": True,
            }
        }
        data = await self._post("/draft_orders.json", body)
        return data.get("draft_order", {})

    async def complete_draft_order(self, draft_order_id: str) -> Dict[str, Any]:
        data = await self._post(f"/draft_orders/{draft_order_id}/complete.json", {})
        return data.get("draft_order", {})

    # ── Storefront cart link ──────────────────────────────────────────────────

    def cart_permalink(self, variant_id: str, quantity: int = 1) -> str:
        return f"{self.store_url}/cart/{variant_id}:{quantity}"


def get_shopify_client(store_url: str, api_token: str) -> ShopifyClient:
    return ShopifyClient(store_url=store_url, api_token=api_token)
