"""
Async Shopify Admin GraphQL client.

Features:
- Exponential backoff on 429 / 5xx responses.
- Configurable per-request timeout.
- Never logs access tokens (masked in all diagnostic output).
- Returns raw dicts; tools are responsible for normalising the shape.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

import httpx

from ..config import get_settings

logger = logging.getLogger(__name__)

_RETRY_ON = {429, 500, 502, 503, 504}
_NO_RETRY_ON = {401, 403}


class ShopifyGraphQLClient:
    def __init__(self) -> None:
        s = get_settings()
        self._domain = s.SHOPIFY_SHOP_DOMAIN
        self._version = s.SHOPIFY_API_VERSION
        # VOICE_SHOPIFY_TIMEOUT_MS takes precedence over the legacy
        # SHOPIFY_TIMEOUT_SECS when the voice runtime is active.
        if s.VOICE_SHOPIFY_TIMEOUT_MS:
            self._timeout = s.VOICE_SHOPIFY_TIMEOUT_MS / 1000
        else:
            self._timeout = s.SHOPIFY_TIMEOUT_SECS
        # Token stored privately; never passed to logger.
        self.__token = s.SHOPIFY_ADMIN_ACCESS_TOKEN
        self._url = (
            f"https://{self._domain}/admin/api/{self._version}/graphql.json"
        )

    @property
    def configured(self) -> bool:
        return bool(self._domain and self.__token)

    def _headers(self) -> dict[str, str]:
        return {
            "X-Shopify-Access-Token": self.__token,
            "Content-Type": "application/json",
        }

    async def execute(
        self,
        query: str,
        variables: Optional[dict] = None,
        retries: int = 3,
    ) -> dict[str, Any]:
        """Execute a GraphQL query/mutation. Retries on transient errors."""
        from ..observability.otel import span
        from ..reliability.shopify_circuit_breaker import guarded_execute, is_circuit_open

        if is_circuit_open():
            from ..reliability.shopify_circuit_breaker import circuit_open_error
            return circuit_open_error()

        async def _run() -> dict[str, Any]:
            with span("shopify_request", operation=query[:40].strip()):
                return await self._execute_once(query, variables, retries)

        return await guarded_execute(_run)

    async def _execute_once(
        self,
        query: str,
        variables: Optional[dict] = None,
        retries: int = 3,
    ) -> dict[str, Any]:
        """Execute a GraphQL query/mutation. Retries on transient errors."""
        payload: dict[str, Any] = {"query": query}
        if variables:
            payload["variables"] = variables

        last_exc: Optional[Exception] = None

        for attempt in range(retries):
            try:
                async with httpx.AsyncClient(timeout=self._timeout) as client:
                    resp = await client.post(
                        self._url,
                        headers=self._headers(),
                        json=payload,
                    )

                if resp.status_code in _NO_RETRY_ON:
                    resp.raise_for_status()

                if resp.status_code in _RETRY_ON:
                    wait = 2 ** attempt
                    logger.warning(
                        "Shopify HTTP %s (attempt %d/%d), retry in %ss",
                        resp.status_code,
                        attempt + 1,
                        retries,
                        wait,
                    )
                    await asyncio.sleep(wait)
                    continue

                resp.raise_for_status()
                data = resp.json()

                if "errors" in data:
                    logger.error("Shopify GraphQL errors: %s", data["errors"])

                return data

            except httpx.TimeoutException as exc:
                last_exc = exc
                wait = 2 ** attempt
                logger.warning(
                    "Shopify timeout (attempt %d/%d), retry in %ss",
                    attempt + 1,
                    retries,
                    wait,
                )
                if attempt < retries - 1:
                    await asyncio.sleep(wait)

            except Exception as exc:
                last_exc = exc
                logger.exception("Shopify request error (attempt %d/%d)", attempt + 1, retries)
                if attempt < retries - 1:
                    await asyncio.sleep(2 ** attempt)

        raise RuntimeError(
            f"Shopify API unavailable after {retries} attempts: {last_exc}"
        )


# Module-level singleton — instantiated once, reused across all requests.
_client: Optional[ShopifyGraphQLClient] = None


def get_shopify_client() -> ShopifyGraphQLClient:
    global _client
    if _client is None:
        _client = ShopifyGraphQLClient()
    return _client
