"""Domain boundary scout (v4.16.0)."""
from __future__ import annotations

import uuid

from ..domain_boundary import classify_domain
from ..speculative_prefetch_manager import PrefetchResult


async def run_scout(*, user_text: str, **_) -> PrefetchResult | None:
    domain = classify_domain(user_text or "")
    if domain.status == "in_domain" and not domain.catalog_search:
        return None
    kind = "out_of_domain_signal" if domain.status == "out_of_domain" else "catalog_candidate"
    return PrefetchResult(
        result_id=str(uuid.uuid4())[:12],
        scout_name="domain_scout",
        kind=kind,  # type: ignore[arg-type]
        confidence=0.9,
        entities={"domain_status": domain.status, "topic": domain.topic},
        facts={
            "redirect_answer": domain.redirect_answer,
            "catalog_search": domain.catalog_search,
        },
        source="domain_scout",
        safe_for_llm=True,
    )
