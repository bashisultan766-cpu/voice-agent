"""
Shopify Admin REST API client.

TODO (Milestone 5 — tool wiring):
    Wire up when SHOPIFY_USE_MOCK=false and credentials are present.
    The interface defined here will be used by the get_order,
    send_payment_link, and sure_shot_catalog_search tools.

    This module will subsume app/shopify/client.py and app/ai/common/shopify.py
    once the real Shopify integration is activated.

Interface (to implement):
    class ShopifyClient:
        def __init__(self, domain: str, access_token: str): ...

        async def get_order(self, order_number: str) -> dict: ...
        async def search_products(self, query: str, limit: int = 5) -> list[dict]: ...
        async def get_variant(self, variant_id: str) -> dict: ...
        async def create_draft_order(
            self, email: str, items: list[dict], note: str = ""
        ) -> dict: ...
        async def cancel_order(self, order_id: str) -> dict: ...

API base:
    https://{domain}/admin/api/2024-01/{resource}.json
    Headers: X-Shopify-Access-Token: {access_token}
    Timeout: 5s per request
    Retries: 2 with 1s backoff on 5xx
"""
from __future__ import annotations
