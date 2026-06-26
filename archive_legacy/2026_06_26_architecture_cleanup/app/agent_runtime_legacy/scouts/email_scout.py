"""Email parse scout — spoken email normalization only (v4.16.0)."""
from __future__ import annotations

import re
import uuid

from ..speculative_prefetch_manager import PrefetchResult

_EMAIL_PAT = re.compile(
    r"\b[\w.+-]+(?:@|\s+at\s+|\s+dot\s+)[\w.-]+(?:\.\s*\w+|\s+dot\s+\w+)\b",
    re.I,
)
_SPOKEN_EMAIL_PAT = re.compile(
    r"\b(gmail|yahoo|outlook|hotmail|icloud)\b",
    re.I,
)


async def run_scout(*, user_text: str, **_) -> PrefetchResult | None:
    text = user_text or ""
    if not _EMAIL_PAT.search(text) and not _SPOKEN_EMAIL_PAT.search(text):
        if "email" not in text.lower():
            return None
    normalized = re.sub(r"\s+at\s+", "@", text, flags=re.I)
    normalized = re.sub(r"\s+dot\s+", ".", normalized, flags=re.I)
    return PrefetchResult(
        result_id=str(uuid.uuid4())[:12],
        scout_name="email_scout",
        kind="email_parse",
        confidence=0.75,
        entities={"raw_email_text": text, "normalized_hint": normalized},
        facts={"needs_confirmation": True},
        source="email_scout",
        safe_for_llm=True,
    )
