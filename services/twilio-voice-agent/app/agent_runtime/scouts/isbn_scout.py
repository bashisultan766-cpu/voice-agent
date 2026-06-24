"""ISBN candidate scout (v4.16.0)."""
from __future__ import annotations

import re
import uuid

from ..speculative_prefetch_manager import PrefetchResult

_ISBN_PAT = re.compile(r"\b(\d{10,13}|\d{1,5}[- ]\d{1,7}[- ]\d{1,7}[- ][\dxX])\b")


async def run_scout(*, user_text: str, **_) -> PrefetchResult | None:
    match = _ISBN_PAT.search(user_text or "")
    if not match:
        return None
    raw = match.group(1)
    normalized = re.sub(r"[^\dXx]", "", raw)
    return PrefetchResult(
        result_id=str(uuid.uuid4())[:12],
        scout_name="isbn_scout",
        kind="isbn_candidate",
        confidence=0.98,
        entities={"isbn": normalized, "raw_isbn": raw},
        facts={"isbn": normalized},
        source="isbn_scout",
        safe_for_llm=True,
        requires_live_verification=True,
    )
