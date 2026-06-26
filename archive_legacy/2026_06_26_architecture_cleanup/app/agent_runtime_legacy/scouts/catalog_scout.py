"""Catalog candidate scout — product/title/author/SKU terms (v4.16.0)."""
from __future__ import annotations

import re
import uuid

from ..speculative_prefetch_manager import PrefetchResult

_CATALOG_PAT = re.compile(
    r"\b(book|isbn|sku|author|title|do you have|looking for|search for|"
    r"product|catalog|buy|order a book)\b",
    re.I,
)
_STOP_WORDS = frozenset({"hello", "brother", "how", "are", "you", "yes", "no", "eric", "name"})


async def run_scout(*, user_text: str, settings=None, **_) -> PrefetchResult | None:
    text = (user_text or "").strip()
    if not text or not _CATALOG_PAT.search(text):
        words = [w for w in re.findall(r"[a-zA-Z']+", text.lower()) if w not in _STOP_WORDS and len(w) > 2]
        if len(words) < 2:
            return None
    entities: dict = {"search_query": text}
    candidates: list[dict] = []
    try:
        from ...integrations.shopify_catalog_indexer import search_catalog_index
        hits = search_catalog_index(text, limit=3, settings=settings)
        candidates = hits
        if hits:
            entities["index_hits"] = len(hits)
    except Exception:
        pass
    confidence = 0.85 if candidates else 0.55
    return PrefetchResult(
        result_id=str(uuid.uuid4())[:12],
        scout_name="catalog_scout",
        kind="catalog_candidate",
        confidence=confidence,
        entities=entities,
        facts={"candidates": candidates[:3]},
        source="catalog_scout",
        safe_for_llm=True,
        requires_live_verification=bool(candidates),
    )
