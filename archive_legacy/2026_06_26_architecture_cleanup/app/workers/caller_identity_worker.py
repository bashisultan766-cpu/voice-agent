"""
CallerIdentityWorker — looks up caller by phone in local CustomerCache.

Cache-only: no live Shopify calls. Returns caller name, masked email,
and last order number if known. Never blocks or raises.
"""
from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING

from .base import WorkerResult

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)


class CallerIdentityWorker:
    name = "caller_identity"

    async def run(
        self,
        session: "SessionState",
        entities: dict,
        settings,
    ) -> WorkerResult:
        t0 = time.monotonic()
        try:
            from ..sync.repositories import CustomerCache
            cache = CustomerCache()
            customer = await cache.get_by_phone(session.from_number)
            if not customer:
                return WorkerResult(
                    worker_name=self.name,
                    success=True,
                    data={},
                    safe_summary="No customer record found for this caller.",
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="cache",
                )
            # Populate session if not already set
            if not session.caller_name and customer.display_name:
                session.caller_name = customer.display_name
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={
                    "display_name": customer.display_name,
                    "email_masked": customer.email_masked,
                    "last_order_number": customer.last_order_number,
                },
                safe_summary=(
                    f"Caller identified: {customer.display_name}."
                    + (f" Last order: {customer.last_order_number}." if customer.last_order_number else "")
                ),
                latency_ms=(time.monotonic() - t0) * 1000,
                source="cache",
            )
        except Exception:
            logger.exception("CallerIdentityWorker error sid=%s", session.call_sid[:6])
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="cache_error",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="none",
            )
