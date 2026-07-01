"""
Match Shopify book data against facility guidelines (v4.33).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Optional

from .guidelines_registry import FacilityGuideline, global_disallowed_keywords, lookup_facility_guideline


@dataclass
class BookMatchResult:
    title: str
    allowed: bool
    violations: list[str] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)
    detected_format: str = ""
    product_tags: list[str] = field(default_factory=list)
    alternative_search_query: str = ""


def _normalize_title(s: str) -> str:
    return (s or "").lower()


def _detect_format(title: str, tags: list[str], product_type: str = "") -> str:
    combined = f"{title} {' '.join(tags)} {product_type}".lower()
    if re.search(r"\b(hardcover|hard cover|hard-back)\b", combined):
        return "hardcover"
    if re.search(r"\b(paperback|softcover|soft cover|mass market)\b", combined):
        return "paperback"
    return "unknown"


def _keyword_hit(text: str, keywords: list[str]) -> Optional[str]:
    t = text.lower()
    for kw in keywords:
        if kw and kw in t:
            return kw
    return None


def check_book_against_facility(
    *,
    title: str,
    facility: FacilityGuideline | None,
    tags: list[str] | None = None,
    product_type: str = "",
    author: str = "",
) -> BookMatchResult:
    """
    Determine if a book likely violates facility rules.

    Uses title, Shopify tags, and product type — never guesses beyond document rules.
    """
    tags = [str(t).lower() for t in (tags or [])]
    title_l = _normalize_title(title)
    combined = f"{title_l} {' '.join(tags)} {product_type.lower()} {author.lower()}"

    violations: list[str] = []
    reasons: list[str] = []
    fmt = _detect_format(title, tags, product_type)

    all_keywords = list(global_disallowed_keywords())
    if facility:
        all_keywords.extend(facility.disallowed_keywords)
        all_keywords.extend(facility.disallowed_categories)

    hit = _keyword_hit(combined, all_keywords)
    if hit:
        violations.append(f"keyword:{hit}")
        tpl = (facility.rejection_templates.get("keyword") if facility else "") or (
            "Content matching '{keyword}' is not allowed at this facility."
        )
        reasons.append(tpl.format(keyword=hit, category=hit))

    if facility and fmt == "hardcover":
        disallowed_fmt = facility.disallowed_formats or []
        if any(f in ("hardcover", "hard cover") for f in disallowed_fmt):
            violations.append("format:hardcover")
            reasons.append(
                facility.rejection_templates.get("hardcover")
                or "This facility accepts paperback/softcover only — hardcover books are returned."
            )

    for cat in (facility.disallowed_categories if facility else []):
        if cat in combined or any(cat in t for t in tags):
            violations.append(f"category:{cat}")
            tpl = facility.rejection_templates.get("category") or (
                "Books in the '{category}' category are not accepted."
            )
            reasons.append(tpl.format(category=cat, keyword=cat))

    allowed = len(violations) == 0
    alt_query = ""
    if not allowed and facility:
        parts = []
        if "paperback" in facility.allowed_formats or "softcover" in facility.allowed_formats:
            parts.append("paperback")
        if author:
            parts.append(author.split()[0])
        else:
            words = [w for w in re.findall(r"[a-z]+", title_l) if len(w) > 3][:2]
            parts.extend(words)
        parts.append("book")
        alt_query = " ".join(parts[:4])

    return BookMatchResult(
        title=title,
        allowed=allowed,
        violations=violations,
        reasons=reasons,
        detected_format=fmt,
        product_tags=tags,
        alternative_search_query=alt_query,
    )


def resolve_facility(name: str, city: str = "", state: str = "") -> Optional[FacilityGuideline]:
    return lookup_facility_guideline(name, city=city, state=state)
