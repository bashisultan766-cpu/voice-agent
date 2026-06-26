"""
StorePolicyWorker — returns store policy, refund policy, or support hours.

Source: local config / static text. Never invents policy details.
"""
from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING

from .base import WorkerResult

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_REFUND_POLICY = (
    "Returns are accepted within 30 days of purchase for unused items. "
    "Refunds are issued to the original payment method within 5-7 business days."
)
_SHIPPING_POLICY = (
    "Standard shipping takes 5-7 business days. "
    "Express shipping takes 2-3 business days. "
    "Free standard shipping on orders over $35."
)
_SUPPORT_HOURS = "Phone support is available Monday through Friday, 9 AM to 6 PM Eastern."
_GENERAL_POLICY = (
    "We accept all major credit cards and PayPal. "
    "Orders may be cancelled within 24 hours of placement."
)


class StorePolicyWorker:
    name = "store_policy"

    async def run(
        self,
        session: "SessionState",
        entities: dict,
        settings,
    ) -> WorkerResult:
        t0 = time.monotonic()
        # Pick the most relevant policy from entities or return general info
        text = entities.get("policy_text")
        if not text:
            # Compose a short multi-policy summary
            text = (
                f"Refund policy: {_REFUND_POLICY} "
                f"Shipping: {_SHIPPING_POLICY} "
                f"Support hours: {_SUPPORT_HOURS}"
            )
        return WorkerResult(
            worker_name=self.name,
            success=True,
            data={
                "refund_policy": _REFUND_POLICY,
                "shipping_policy": _SHIPPING_POLICY,
                "support_hours": _SUPPORT_HOURS,
            },
            safe_summary=text,
            latency_ms=(time.monotonic() - t0) * 1000,
            source="local",
        )
