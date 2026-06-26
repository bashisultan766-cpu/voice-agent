"""Order candidate scout (v4.16.0)."""
from __future__ import annotations

import re
import uuid

from ..speculative_prefetch_manager import PrefetchResult

_ORDER_PAT = re.compile(
    r"\b(order|tracking|where is my order|order status|order number)\b",
    re.I,
)
_ORDER_NUM_PAT = re.compile(r"\b(?:order\s*(?:#|number)?\s*)?(\d{4,})\b", re.I)


async def run_scout(*, user_text: str, **_) -> PrefetchResult | None:
    text = user_text or ""
    if not _ORDER_PAT.search(text):
        return None
    num_match = _ORDER_NUM_PAT.search(text)
    entities: dict = {"search_query": text}
    confidence = 0.6
    if num_match:
        entities["order_number"] = num_match.group(1)
        confidence = 0.9
    return PrefetchResult(
        result_id=str(uuid.uuid4())[:12],
        scout_name="order_scout",
        kind="order_candidate",
        confidence=confidence,
        entities=entities,
        facts={"has_order_number": bool(num_match)},
        source="order_scout",
        safe_for_llm=True,
        requires_live_verification=True,
    )
