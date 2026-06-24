"""
Deterministic catalog-candidate ranking (v4.16+).

Fixes the live defect where a partial ISBN fragment (e.g. "9780") returned an
unrelated product ("From Dead to Worse") and was wrongly preferred over the
exact ISBN match ("100,000 and Freedom Too...").

Ranking, strongest first:

    exact_valid_isbn > exact_barcode > exact_sku > exact_title
        > fuzzy_title > fragment

A candidate produced from a partial/invalid ISBN fragment is always classified
as ``fragment`` and can never outrank an exact match. The final response must
use only the single top candidate returned by ``select_top_candidate``.

This module is pure (no I/O) so it is trivially unit-testable.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Iterable, Optional

from ..tools.isbn import (
    extract_isbn_candidate,
    is_strict_valid_isbn,
    looks_like_isbn_fragment,
    normalize_isbn,
)

logger = logging.getLogger(__name__)

# Higher rank wins. Gaps left intentionally for future match types.
MATCH_RANK: dict[str, int] = {
    "exact_valid_isbn": 100,
    "exact_barcode": 90,
    "exact_sku": 80,
    "exact_title": 70,
    "fuzzy_title": 40,
    "fragment": 10,
    "unknown": 0,
}

_VALID_MATCH_TYPES = frozenset(MATCH_RANK)


def _norm_title(title: str) -> str:
    return "".join(ch for ch in (title or "").lower() if ch.isalnum() or ch.isspace()).strip()


@dataclass
class RankedCandidate:
    """A single catalog candidate with a classified match type."""

    title: str
    match_type: str = "unknown"
    isbn: str = ""
    barcode: str = ""
    sku: str = ""
    product_id: str = ""
    price: str = ""
    available: bool = True
    source: str = ""
    # Original query/fragment that produced this candidate (for diagnostics).
    origin_query: str = ""
    raw: dict = field(default_factory=dict)

    @property
    def rank(self) -> int:
        return MATCH_RANK.get(self.match_type, 0)


def classify_match_type(
    candidate: dict,
    *,
    requested_isbn: Optional[str] = None,
    requested_title: Optional[str] = None,
    origin_query: str = "",
) -> str:
    """
    Classify how a raw candidate dict matched the caller's request.

    requested_isbn should be a checksum-valid ISBN (or None). origin_query is
    the raw text/fragment that produced the candidate; if it looks like an ISBN
    fragment but is not a complete valid ISBN, the candidate is a ``fragment``.
    """
    cand_isbn = str(candidate.get("isbn") or "").strip()
    cand_barcode = str(candidate.get("barcode") or candidate.get("isbn") or "").strip()
    cand_sku = str(candidate.get("sku") or "").strip()
    cand_title = str(candidate.get("title") or "").strip()

    # An explicit, checksum-valid ISBN match is the strongest signal.
    if requested_isbn and is_strict_valid_isbn(requested_isbn):
        norm_req = extract_isbn_candidate(requested_isbn) or requested_isbn
        for value in (cand_isbn, cand_barcode):
            norm_val = extract_isbn_candidate(value) if value else None
            if norm_val and norm_val == norm_req:
                return "exact_valid_isbn"
        # The lookup used a valid ISBN; treat barcode equality leniently too.
        if cand_barcode and cand_barcode.replace("-", "") == norm_req:
            return "exact_barcode"

    # If the candidate came from a partial/invalid ISBN fragment, it is a
    # fragment regardless of what Shopify returned. This is the core guard.
    if origin_query and looks_like_isbn_fragment(origin_query) and not (
        requested_isbn and is_strict_valid_isbn(requested_isbn)
    ):
        return "fragment"

    declared = str(candidate.get("match_type") or "").strip()
    if declared in _VALID_MATCH_TYPES and declared != "unknown":
        return declared

    if cand_barcode and requested_isbn and cand_barcode.replace("-", "") == requested_isbn:
        return "exact_barcode"
    if cand_sku and requested_isbn and cand_sku == requested_isbn:
        return "exact_sku"

    if requested_title and cand_title:
        if _norm_title(cand_title) == _norm_title(requested_title):
            return "exact_title"
        return "fuzzy_title"

    if cand_title:
        return "fuzzy_title"
    return "unknown"


def build_ranked_candidate(
    candidate: dict,
    *,
    requested_isbn: Optional[str] = None,
    requested_title: Optional[str] = None,
    origin_query: str = "",
    source: str = "",
) -> RankedCandidate:
    match_type = classify_match_type(
        candidate,
        requested_isbn=requested_isbn,
        requested_title=requested_title,
        origin_query=origin_query,
    )
    return RankedCandidate(
        title=str(candidate.get("title") or "").strip(),
        match_type=match_type,
        isbn=str(candidate.get("isbn") or "").strip(),
        barcode=str(candidate.get("barcode") or "").strip(),
        sku=str(candidate.get("sku") or "").strip(),
        product_id=str(candidate.get("id") or candidate.get("product_id") or "").strip(),
        price=str(candidate.get("price") or "").strip(),
        available=bool(candidate.get("available", True)),
        source=source or str(candidate.get("source") or ""),
        origin_query=origin_query,
        raw=candidate,
    )


def rank_candidates(candidates: Iterable[RankedCandidate]) -> list[RankedCandidate]:
    """
    Stable-sort candidates strongest first.

    Tie-break (after rank): available before unavailable, then original order
    (Python's sort is stable) so the first worker to report wins on a true tie.
    """
    indexed = list(enumerate(candidates))
    indexed.sort(key=lambda pair: (-pair[1].rank, not pair[1].available, pair[0]))
    return [c for _, c in indexed]


def select_top_candidate(
    candidates: Iterable[RankedCandidate],
    *,
    drop_fragments_when_better_exists: bool = True,
) -> Optional[RankedCandidate]:
    """
    Return the single best candidate, or None.

    When a non-fragment candidate exists, fragments are never selected. This is
    the only function the final responder should use to pick a product.
    """
    ranked = rank_candidates(candidates)
    if not ranked:
        return None

    if drop_fragments_when_better_exists:
        non_fragment = [c for c in ranked if c.match_type != "fragment"]
        if non_fragment:
            ranked = non_fragment

    top = ranked[0]
    logger.info(
        "isbn_candidate_selected match_type=%s rank=%d total=%d",
        top.match_type,
        top.rank,
        len(list(ranked)),
    )
    return top


def select_best_product(
    raw_candidates: list[dict],
    *,
    requested_isbn: Optional[str] = None,
    requested_title: Optional[str] = None,
    origin_query: str = "",
) -> Optional[RankedCandidate]:
    """
    Convenience: classify + rank + select from a list of raw candidate dicts.

    ``requested_isbn`` is normalized to a checksum-valid ISBN internally; a
    fragment like "9780" is ignored so it can never become the requested ISBN.
    """
    valid_isbn = None
    if requested_isbn:
        valid_isbn = extract_isbn_candidate(requested_isbn) or (
            requested_isbn if is_strict_valid_isbn(requested_isbn) else None
        )

    built = [
        build_ranked_candidate(
            c,
            requested_isbn=valid_isbn,
            requested_title=requested_title,
            origin_query=origin_query or (requested_isbn or ""),
        )
        for c in raw_candidates
        if c
    ]
    return select_top_candidate(built)
