"""Publication scout — newspapers, magazines, subscriptions (v4.16.0)."""
from __future__ import annotations

import re
import uuid

from ..speculative_prefetch_manager import PrefetchResult

_PUB_PAT = re.compile(
    r"\b(newspaper|magazine|subscription|usa today|people magazine|wall street journal|"
    r"new york times|delivery|3 months|6 months|12 months|5 day|7 day)\b",
    re.I,
)


async def run_scout(*, user_text: str, **_) -> PrefetchResult | None:
    text = user_text or ""
    if not _PUB_PAT.search(text):
        return None
    lowered = text.lower()
    kind = "publication"
    if "newspaper" in lowered or "usa today" in lowered:
        kind = "newspaper"
    elif "magazine" in lowered or "people" in lowered:
        kind = "magazine"
    elif "subscription" in lowered or re.search(r"\b\d+\s*months?\b", lowered):
        kind = "subscription"
    return PrefetchResult(
        result_id=str(uuid.uuid4())[:12],
        scout_name="publication_scout",
        kind="publication_candidate",
        confidence=0.9,
        entities={"product_kind": kind, "search_query": text},
        facts={"publication_kind": kind},
        source="publication_scout",
        safe_for_llm=True,
        requires_live_verification=True,
    )
