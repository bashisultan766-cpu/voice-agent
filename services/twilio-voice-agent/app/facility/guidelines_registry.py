"""
Facility guidelines registry (v4.33).

Canonical source: ``app/data/facility_guidelines.json`` (built from client CSV/PDF
via ``python -m app.scripts.ingest_facility_documents``).

Each facility record includes website URL, allowed/disallowed formats and content,
and rejection templates for customer-facing explanations.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

_DATA_PATH = Path(__file__).parent.parent / "data" / "facility_guidelines.json"
_GUIDELINES: dict[str, Any] = {}
_LOADED = False


def _normalize(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


@dataclass
class FacilityGuideline:
    facility_id: str = ""
    name: str = ""
    aliases: list[str] = field(default_factory=list)
    city: str = ""
    state: str = ""
    approved: bool = True
    website_name: str = ""
    website_url: str = ""
    allowed_formats: list[str] = field(default_factory=list)
    disallowed_formats: list[str] = field(default_factory=list)
    disallowed_keywords: list[str] = field(default_factory=list)
    disallowed_categories: list[str] = field(default_factory=list)
    content_notes: str = ""
    rejection_templates: dict[str, str] = field(default_factory=dict)
    source_documents: list[str] = field(default_factory=list)
    document_excerpt: str = ""

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "FacilityGuideline":
        return cls(
            facility_id=str(data.get("facility_id") or ""),
            name=str(data.get("name") or ""),
            aliases=list(data.get("aliases") or []),
            city=str(data.get("city") or ""),
            state=str(data.get("state") or ""),
            approved=bool(data.get("approved", True)),
            website_name=str(data.get("website_name") or ""),
            website_url=str(data.get("website_url") or ""),
            allowed_formats=[str(x).lower() for x in (data.get("allowed_formats") or [])],
            disallowed_formats=[str(x).lower() for x in (data.get("disallowed_formats") or [])],
            disallowed_keywords=[str(x).lower() for x in (data.get("disallowed_keywords") or [])],
            disallowed_categories=[str(x).lower() for x in (data.get("disallowed_categories") or [])],
            content_notes=str(data.get("content_notes") or ""),
            rejection_templates=dict(data.get("rejection_templates") or {}),
            source_documents=list(data.get("source_documents") or []),
            document_excerpt=str(data.get("document_excerpt") or ""),
        )


def load_guidelines(*, reload: bool = False) -> dict[str, Any]:
    global _GUIDELINES, _LOADED
    if _LOADED and not reload:
        return _GUIDELINES
    try:
        if _DATA_PATH.exists():
            with open(_DATA_PATH, encoding="utf-8") as f:
                _GUIDELINES = json.load(f)
        else:
            logger.warning("facility_guidelines.json not found at %s", _DATA_PATH)
            _GUIDELINES = {"facilities": [], "global_disallowed_keywords": []}
    except Exception as exc:
        logger.error("Failed to load facility_guidelines.json: %s", exc)
        _GUIDELINES = {"facilities": [], "global_disallowed_keywords": []}
    _LOADED = True
    return _GUIDELINES


def all_facilities() -> list[FacilityGuideline]:
    data = load_guidelines()
    return [FacilityGuideline.from_dict(f) for f in (data.get("facilities") or [])]


def global_disallowed_keywords() -> list[str]:
    data = load_guidelines()
    return [str(k).lower() for k in (data.get("global_disallowed_keywords") or [])]


def lookup_facility_guideline(
    name: str,
    *,
    city: str = "",
    state: str = "",
) -> Optional[FacilityGuideline]:
    """Match facility by name, alias, city, or state."""
    norm = _normalize(name)
    if not norm:
        return None

    facilities = all_facilities()
    candidates: list[FacilityGuideline] = []

    for fac in facilities:
        names = [_normalize(fac.name), *[_normalize(a) for a in fac.aliases]]
        if norm in names or any(norm in n or n in norm for n in names if n):
            candidates.append(fac)

    if not candidates:
        for fac in facilities:
            if norm in _normalize(f"{fac.city} {fac.state}"):
                candidates.append(fac)

    if not candidates:
        return None

    if city or state:
        nc, ns = _normalize(city), _normalize(state)
        for fac in candidates:
            if (not nc or _normalize(fac.city) == nc) and (not ns or _normalize(fac.state) == ns):
                return fac

    return candidates[0]


def facility_knowledge_summary(fac: FacilityGuideline) -> str:
    """Compact summary for LLM system context."""
    lines = [
        f"Facility: {fac.name}" + (f" ({fac.city}, {fac.state})" if fac.city else ""),
        f"Approved for SureShot shipping: {'yes' if fac.approved else 'no'}",
    ]
    if fac.website_name and fac.website_url:
        lines.append(f"Official guidelines: {fac.website_name} — {fac.website_url}")
    if fac.allowed_formats:
        lines.append(f"Allowed formats: {', '.join(fac.allowed_formats)}")
    if fac.disallowed_formats:
        lines.append(f"Not allowed formats: {', '.join(fac.disallowed_formats)}")
    if fac.disallowed_keywords:
        lines.append(f"Disallowed content keywords: {', '.join(fac.disallowed_keywords[:15])}")
    if fac.content_notes:
        lines.append(f"Notes: {fac.content_notes[:300]}")
    if fac.document_excerpt:
        lines.append(f"Document excerpt: {fac.document_excerpt[:400]}")
    return "\n".join(lines)


def guidelines_for_llm_context(
    *,
    facility_name: str = "",
    max_facilities: int = 5,
) -> str:
    """Build facility knowledge block for system prompt."""
    data = load_guidelines()
    lines = [
        "FACILITY GUIDELINES (client PDF + Google Sheets — cite website URLs when explaining rejections):",
        data.get("global_notes", ""),
    ]

    gkw = global_disallowed_keywords()
    if gkw:
        lines.append(f"Global disallowed keywords: {', '.join(gkw)}")

    if facility_name:
        fac = lookup_facility_guideline(facility_name)
        if fac:
            lines.append("")
            lines.append(facility_knowledge_summary(fac))
            lines.append(
                "When explaining rejections: acknowledge frustration, name the specific rule "
                "(format or content), share website_url, offer catalog alternatives."
            )
        else:
            lines.append(
                f"No structured record for '{facility_name}' — ask for exact facility name "
                "and use reconcile_order_facility_books with the order number."
            )
    else:
        facs = all_facilities()[:max_facilities]
        lines.append(f"Facilities on file: {len(all_facilities())}")
        for fac in facs:
            url = f" | {fac.website_url}" if fac.website_url else ""
            lines.append(f"  • {fac.name} ({fac.state}){url}")

    return "\n".join(line for line in lines if line)
