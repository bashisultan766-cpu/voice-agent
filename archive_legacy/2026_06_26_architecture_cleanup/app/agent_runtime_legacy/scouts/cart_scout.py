"""Cart state scout — read-only cart snapshot (v4.16.0)."""
from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from ..speculative_prefetch_manager import PrefetchResult

if TYPE_CHECKING:
    from ..commerce_session import CommerceSession


async def run_scout(*, commerce_session: "CommerceSession | None" = None, **_) -> PrefetchResult | None:
    if commerce_session is None:
        return None
    from ..cart_orchestrator import cart_count
    from ..commerce_session import cart_summary as commerce_cart_summary

    count = cart_count(commerce_session)
    summary = commerce_cart_summary(commerce_session)
    return PrefetchResult(
        result_id=str(uuid.uuid4())[:12],
        scout_name="cart_scout",
        kind="cart_state",
        confidence=1.0,
        entities={"cart_count": count},
        facts={"summary": summary, "count": count},
        source="cart_scout",
        safe_for_llm=True,
    )
