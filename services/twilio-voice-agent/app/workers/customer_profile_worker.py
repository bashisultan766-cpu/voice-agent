"""
CustomerProfileWorker — enriched caller profile from CustomerCache.

Returns safe customer profile with masked email. Never includes full email.
Cache-only: no live Shopify calls.
"""
from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING

from .base import WorkerResult

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)


class CustomerProfileWorker:
    name = "customer_profile"

    async def run(
        self,
        session: "SessionState",
        entities: dict,
        settings,
    ) -> WorkerResult:
        t0 = time.monotonic()
        phone = entities.get("phone") or session.from_number
        try:
            from ..sync.repositories import CustomerCache
            cache = CustomerCache()
            customer = await cache.get_by_phone(phone)
            if not customer:
                return WorkerResult(
                    worker_name=self.name,
                    success=True,
                    data={},
                    safe_summary="No profile on file for this caller.",
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="cache",
                )
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={
                    "display_name": customer.display_name,
                    # Never include full email; always masked
                    "email_masked": customer.email_masked,
                    "last_order_number": customer.last_order_number,
                },
                safe_summary=(
                    f"Customer profile found: {customer.display_name}"
                    + (f", email on file (masked): {customer.email_masked}" if customer.email_masked else "")
                    + "."
                ),
                latency_ms=(time.monotonic() - t0) * 1000,
                source="cache",
            )
        except Exception:
            logger.exception("CustomerProfileWorker error sid=%s", session.call_sid[:6])
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="cache_error",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="none",
            )
