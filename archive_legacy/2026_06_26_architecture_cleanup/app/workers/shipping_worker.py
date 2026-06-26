"""
ShippingWorker — returns shipping policy and method info (v4.8).

Never invents shipping fees or ETAs. Uses order data when available.
Never says "Processing Fee".
"""
from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING

from .base import WorkerResult
from ..shipping.policy import (
    format_subtotal_message,
    format_shipping_message,
    build_order_shipping_response,
    extract_shipping_context,
    ShippingContext,
)

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_DEFAULT_SHIPPING_POLICY = (
    "We ship using Media Mail and Priority Mail through USPS. "
    "Shipping cost depends on the shipping method and destination. "
    "Exact shipping is shown at checkout. "
    "We do not invent or estimate shipping fees."
)


class ShippingWorker:
    name = "shipping"

    async def run(
        self,
        session: "SessionState",
        entities: dict,
        settings,
    ) -> WorkerResult:
        t0 = time.monotonic()

        raw_text = entities.get("raw_text", "")
        default_method = getattr(settings, "SHIPPING_DEFAULT_METHOD", "Media Mail")
        alt_method = getattr(settings, "SHIPPING_ALT_METHOD", "Priority Mail")

        # If there is recent order data on session, use it for shipping method
        order_data = entities.get("order_data") or {}

        if order_data:
            response = build_order_shipping_response(order_data, raw_text)
            ctx = extract_shipping_context(order_data)
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={
                    "shipping_method": ctx.method or "",
                    "shipping_amount": ctx.amount or "",
                    "is_known": ctx.is_known,
                },
                safe_summary=response,
                latency_ms=(time.monotonic() - t0) * 1000,
                source="order",
            )

        policy = getattr(settings, "SHIPPING_POLICY_TEXT", None) or _DEFAULT_SHIPPING_POLICY
        summary = (
            f"We offer {default_method} and {alt_method} shipping. "
            + policy
            if not getattr(settings, "SHIPPING_POLICY_TEXT", None)
            else policy
        )
        return WorkerResult(
            worker_name=self.name,
            success=True,
            data={
                "default_method": default_method,
                "alt_method": alt_method,
                "policy": policy,
            },
            safe_summary=summary,
            latency_ms=(time.monotonic() - t0) * 1000,
            source="local",
        )
