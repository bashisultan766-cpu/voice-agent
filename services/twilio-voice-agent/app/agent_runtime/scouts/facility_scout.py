"""Facility candidate scout (v4.16.0)."""
from __future__ import annotations

import re
import uuid

from ..speculative_prefetch_manager import PrefetchResult

_FACILITY_PAT = re.compile(
    r"\b(facility|inmate|prison|jail|correctional|approved to ship)\b",
    re.I,
)


async def run_scout(*, user_text: str, **_) -> PrefetchResult | None:
    if not _FACILITY_PAT.search(user_text or ""):
        return None
    return PrefetchResult(
        result_id=str(uuid.uuid4())[:12],
        scout_name="facility_scout",
        kind="facility_candidate",
        confidence=0.85,
        entities={"search_query": user_text},
        facts={},
        source="facility_scout",
        safe_for_llm=True,
        requires_live_verification=True,
    )
