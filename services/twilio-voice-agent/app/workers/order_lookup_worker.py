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
            shipping_method = (
                result.get("shipping_method")
                or result.get("shipping_title")
                or result.get("carrier")
                or ""
            )
            shipping_amount = result.get("shipping") or ""
            subtotal = result.get("subtotal") or ""
            tracking_number = result.get("tracking_number") or ""
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={
                    "order_number": result.get("order_number", order_number),
                    "financial_status": fin,
                    "fulfillment_status": ful,
                    "shipping_method": shipping_method,
                    "shipping_amount": shipping_amount,
                    "subtotal": subtotal,
                    "tracking_number": tracking_number,
                },
                safe_summary=_order_summary_full(
                    result.get("order_number", order_number),
                    fin, ful, shipping_method, shipping_amount, subtotal,
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
    from ..shipping.policy import format_subtotal_message, extract_shipping_context, format_shipping_message

    parts = [f"Order {order.order_number}"]
    if order.financial_status:
        parts.append(f"payment {order.financial_status}")
    if order.fulfillment_status:
        parts.append(f"fulfillment {order.fulfillment_status}")
    summary = ", ".join(parts) + "."

    # Add shipping method if available
    shipping_method = getattr(order, "shipping_method", "") or ""
    if shipping_method:
        summary += f" Shipping method: {shipping_method}."
    return summary


def _order_summary_full(
    order_number: str,
    financial_status: str,
    fulfillment_status: str,
    shipping_method: str,
    shipping_amount: str,
    subtotal: str,
) -> str:
    from ..shipping.policy import format_subtotal_message, format_shipping_message, ShippingContext

    parts = [f"Order {order_number}"]
    if financial_status:
        parts.append(f"payment {financial_status}")
    if fulfillment_status:
        parts.append(f"fulfillment {fulfillment_status}")
    summary = ", ".join(parts) + "."

    if subtotal:
        summary += " " + format_subtotal_message(subtotal)

    ctx = ShippingContext(
        method=shipping_method or None,
        amount=shipping_amount or None,
        is_known=bool(shipping_method or shipping_amount),
    )
    summary += " " + format_shipping_message(ctx)

    return summary
