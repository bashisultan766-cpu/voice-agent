"""
ShippingWorker — returns store shipping policy and estimated delivery info.

Returns static/configured text; never invents shipping fees or ETAs.
Source: local config. No Shopify calls for policy text.
"""
from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING

from .base import WorkerResult

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_DEFAULT_SHIPPING_POLICY = (
    "We offer standard shipping (5-7 business days) and express shipping (2-3 business days). "
    "Free standard shipping on orders over $35. "
    "We do not invent or estimate shipping fees — exact costs are shown at checkout."
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
        policy = getattr(settings, "SHIPPING_POLICY_TEXT", None) or _DEFAULT_SHIPPING_POLICY
        return WorkerResult(
            worker_name=self.name,
            success=True,
            data={"policy": policy},
            safe_summary=policy,
            latency_ms=(time.monotonic() - t0) * 1000,
            source="local",
        )
