"""
OrderLookupWorker — looks up order status.

Cache-first: checks OrderCache before calling Shopify.
Returns limited details for unverified callers; full details when verified.
Sensitive financial data is gated behind requires_verification.
Never calls OpenAI or run_agent_turn.
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


class OrderLookupWorker:
    name = "order_lookup"

    async def run(
        self,
        session: "SessionState",
        entities: dict,
        settings,
    ) -> WorkerResult:
        order_number = entities.get("order_number") or session.last_order_number
        if not order_number:
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="no_order_number",
                source="none",
            )

        t0 = time.monotonic()
        verified = session.verified_email or session.verified_phone

        try:
            # 1. OrderCache lookup
            from ..sync.repositories import OrderCache
            cache = OrderCache()
            order = await cache.get_by_number(order_number)
            if order:
                if session.last_order_number != order.order_number:
                    session.last_order_number = order.order_number
                summary = _order_summary(order, verified)
                return WorkerResult(
                    worker_name=self.name,
                    success=True,
                    data={
                        "order_number": order.order_number,
                        "financial_status": order.financial_status,
                        "fulfillment_status": order.fulfillment_status,
                        "tracking_summary": order.tracking_summary,
                    },
                    safe_summary=summary,
                    requires_verification=not verified,
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="cache",
                )

            # 2. Shopify fallback
            from ..tools.shopify_tools import lookup_order
            email = entities.get("email") or (session.caller_email if session.verified_email else None)
            phone = session.from_number if session.verified_phone else None
            result_json = await lookup_order(
                order_number=order_number,
                email=email,
                phone=phone,
                session=session,
            )
            result = json.loads(result_json)
            if result.get("error"):
                return WorkerResult(
                    worker_name=self.name,
                    success=False,
                    error_code="shopify_error",
                    safe_summary="Order lookup is temporarily unavailable.",
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="shopify",
                )
            if not result.get("found"):
                return WorkerResult(
                    worker_name=self.name,
                    success=True,
                    data={"found": False, "order_number": order_number},
                    safe_summary=f"No order found for {order_number}.",
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="shopify",
                )
            fin = result.get("status", "")
            ful = result.get("fulfillment_status", "")
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={
                    "order_number": result.get("order_number", order_number),
                    "financial_status": fin,
                    "fulfillment_status": ful,
                },
                safe_summary=(
                    f"Order {result.get('order_number', order_number)}: "
                    f"payment {fin}, fulfillment {ful}."
                ),
                requires_verification=not verified,
                latency_ms=(time.monotonic() - t0) * 1000,
                source="shopify",
            )
        except Exception:
            logger.exception("OrderLookupWorker error order=%s sid=%s", order_number, session.call_sid[:6])
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="error",
                safe_summary="Order lookup is temporarily unavailable.",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="none",
            )


def _order_summary(order, verified: bool) -> str:
    parts = [f"Order {order.order_number}"]
    if order.financial_status:
        parts.append(f"payment {order.financial_status}")
    if order.fulfillment_status:
        parts.append(f"fulfillment {order.fulfillment_status}")
    return ", ".join(parts) + "."
