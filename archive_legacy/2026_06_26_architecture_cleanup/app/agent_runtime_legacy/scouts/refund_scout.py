"""Refund candidate scout (v4.16.0)."""
from __future__ import annotations

import re
import uuid

from ..speculative_prefetch_manager import PrefetchResult

_REFUND_PAT = re.compile(r"\b(refund|money back|charge back|return)\b", re.I)


async def run_scout(*, user_text: str, **_) -> PrefetchResult | None:
    if not _REFUND_PAT.search(user_text or ""):
        return None
    return PrefetchResult(
        result_id=str(uuid.uuid4())[:12],
        scout_name="refund_scout",
        kind="refund_candidate",
        confidence=0.85,
        entities={"search_query": user_text},
        facts={},
        source="refund_scout",
        safe_for_llm=True,
        requires_live_verification=True,
    )
