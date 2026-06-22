"""StoreInfoWorker — basic business identity questions (v4.5)."""
from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING

from .base import WorkerResult

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_STORE_RESPONSE = (
    "You're calling SureShot Books. I can help with books, orders, shipping, "
    "refunds, facility questions, and payment links."
)
_PHONE_RESPONSE = (
    "You're calling SureShot Books. For phone support, check sureshotbooks.com "
    "or the number on your order confirmation."
)


class StoreInfoWorker:
    name = "store_info"

    async def run(
        self,
        session: "SessionState",
        entities: dict,
        settings,
    ) -> WorkerResult:
        t0 = time.monotonic()
        topic = entities.get("store_info_topic", "general")
        if topic == "phone":
            msg = _PHONE_RESPONSE
        else:
            msg = _STORE_RESPONSE
        return WorkerResult(
            worker_name=self.name,
            success=True,
            data={"topic": topic},
            safe_summary=msg,
            latency_ms=(time.monotonic() - t0) * 1000,
            source="local",
        )
