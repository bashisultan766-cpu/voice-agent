"""
CheckoutWorker — creates a Shopify draft order / payment link.

Prevents duplicate draft orders within the same call.
Does not call OpenAI. Calls Shopify create_checkout_link tool.
"""
from __future__ import annotations

import json
import logging
import time
from typing import TYPE_CHECKING

from .base import WorkerResult

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)


class CheckoutWorker:
    name = "checkout"

    async def run(
        self,
        session: "SessionState",
        entities: dict,
        settings,
    ) -> WorkerResult:
        t0 = time.monotonic()

        # De-duplicate: already have a checkout URL this call?
        if session.pending_checkout_url:
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={
                    "checkout_url": session.pending_checkout_url,
                    "duplicate": True,
                },
                safe_summary=(
                    "You already have a payment link from this call. "
                    "Shall I email it to you?"
                ),
                latency_ms=(time.monotonic() - t0) * 1000,
                source="local",
            )

        items = session.cart_items
        if not items:
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="no_items",
                safe_summary="No items in cart to check out.",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="none",
            )

        try:
            from ..tools.shopify_tools import create_checkout_link
            # Use confirmed_email only — never caller_email or pending_email
            email = getattr(session, "confirmed_email", "") or None
            result_json = await create_checkout_link(
                items=items,
                email=email,
                customer_name=session.caller_name or None,
                session=session,
            )
            result = json.loads(result_json)

            if not result.get("success"):
                return WorkerResult(
                    worker_name=self.name,
                    success=False,
                    error_code="checkout_error",
                    safe_summary=result.get("error", "Could not create checkout link."),
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="shopify",
                )
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={
                    "checkout_url": result.get("checkout_url", ""),
                    "order_name": result.get("order_name", ""),
                },
                safe_summary="Payment link created. Shall I email it to you?",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="shopify",
            )
        except Exception:
            logger.exception("CheckoutWorker error sid=%s", session.call_sid[:6])
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="error",
                safe_summary="Could not create checkout link at this time.",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="none",
            )
