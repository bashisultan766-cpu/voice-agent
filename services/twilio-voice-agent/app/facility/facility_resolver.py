"""
Resolve correctional facility names from caller text or Shopify order data.
"""
from __future__ import annotations

import re
from typing import Any, Optional

from .guidelines_registry import FacilityGuideline, all_facilities, lookup_facility_guideline


_FACILITY_CUE = re.compile(
    r"\b(facility|prison|jail|correctional|penitentiary|institution|unit|doc|cdcr|tdcj)\b",
    re.I,
)

_REJECT_INTENT = re.compile(
    r"\b("
    r"not (?:coming|arriving|delivered|accepted|allowed)|"
    r"didn'?t (?:arrive|come|get)|"
    r"why (?:was|were|is|are|didn).*(?:book|title|come)|"
    r"returned|rejected|sent back|turned back|bounced|refused|"
    r"only (?:some|one|part)|partial(?:ly)?|"
    r"book(?:s)? not allowed|restriction"
    r")\b",
    re.I,
)


def facility_rejection_intent(text: str) -> bool:
    """True when caller likely asks why some books did not reach the inmate."""
    return bool(_REJECT_INTENT.search(text or ""))


def facility_name_in_text(text: str) -> str:
    """Return the best-matching known facility name mentioned in caller text."""
    t = (text or "").lower()
    if not t.strip():
        return ""

    best: tuple[int, str] = (0, "")
    for fac in all_facilities():
        candidates = [fac.name, *fac.aliases, f"{fac.name} {fac.city}".strip()]
        for cand in candidates:
            c = (cand or "").strip().lower()
            if len(c) < 4:
                continue
            if c in t:
                score = len(c) + (10 if fac.city and fac.city.lower() in t else 0)
                if score > best[0]:
                    best = (score, fac.name)
    return best[1]


def facility_from_order(order: dict[str, Any]) -> str:
    """
    Infer facility name from Shopify order shipping address, note, tags, or attributes.
    """
    if not order:
        return ""

    attrs = order.get("custom_attributes") or {}
    for key in ("facility_name", "facility", "institution", "prison"):
        val = (attrs.get(key) or "").strip()
        if val:
            fac = lookup_facility_guideline(val)
            return fac.name if fac else val

    note = (order.get("note") or "").strip()
    if note:
        hit = facility_name_in_text(note)
        if hit:
            return hit

    tags = order.get("tags") or []
    if isinstance(tags, str):
        tags = [t.strip() for t in tags.split(",")]
    for tag in tags:
        hit = facility_name_in_text(str(tag))
        if hit:
            return hit

    ship = order.get("shipping_address") or {}
    for field in ("company", "address1", "address2", "city"):
        val = (ship.get(field) or "").strip()
        if not val:
            continue
        hit = facility_name_in_text(val)
        if hit:
            return hit
        if _FACILITY_CUE.search(val):
            fac = lookup_facility_guideline(val)
            if fac:
                return fac.name
            return val[:80]

    combined = " ".join(
        str(x)
        for x in [
            note,
            " ".join(tags) if tags else "",
            ship.get("company", ""),
            ship.get("address1", ""),
            ship.get("address2", ""),
        ]
    )
    return facility_name_in_text(combined)


def resolve_facility_for_call(
    *,
    caller_text: str = "",
    facility_name: str = "",
    order: dict[str, Any] | None = None,
    session_facility: str = "",
) -> Optional[FacilityGuideline]:
    """Pick the best facility guideline record for this call."""
    name = (facility_name or session_facility or "").strip()
    if not name and order:
        name = facility_from_order(order)
    if not name:
        name = facility_name_in_text(caller_text)
    if not name:
        return None
    return lookup_facility_guideline(name)
