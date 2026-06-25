"""
Facility book restriction checker (v4.8).

Data source: app/data/facility_restrictions.json
Checks books against restricted keywords, titles, and categories.
Never guesses — returns only what is on record.
"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_DATA_PATH = Path(__file__).parent.parent / "data" / "facility_restrictions.json"

_RESTRICTIONS: dict = {}
_LOADED = False


def _load_restrictions() -> dict:
    global _RESTRICTIONS, _LOADED
    if _LOADED:
        return _RESTRICTIONS
    try:
        if _DATA_PATH.exists():
            with open(_DATA_PATH, encoding="utf-8") as f:
                _RESTRICTIONS = json.load(f)
        else:
            logger.warning("facility_restrictions.json not found at %s", _DATA_PATH)
    except Exception as exc:
        logger.error("Failed to load facility_restrictions.json: %s", exc)
    _LOADED = True
    return _RESTRICTIONS


def _normalize(s: str) -> str:
    return s.lower().strip()


def check_book_restriction(title: str, facility_name: str = "") -> Optional[str]:
    """Return restriction reason key if restricted, else None."""
    from .book_content_matcher import check_book_against_facility
    from .guidelines_registry import lookup_facility_guideline

    fac = lookup_facility_guideline(facility_name) if facility_name else None
    result = check_book_against_facility(title=title, facility=fac)
    if result.allowed:
        return None
    return result.violations[0] if result.violations else "restricted"


def check_order_restrictions(
    book_titles: list[str],
    facility_name: str = "",
) -> dict:
    from .book_content_matcher import check_book_against_facility
    from .guidelines_registry import lookup_facility_guideline

    fac = lookup_facility_guideline(facility_name) if facility_name else None
    restricted = []
    for title in book_titles:
        result = check_book_against_facility(title=title, facility=fac)
        if not result.allowed:
            restricted.append(title)

    if not book_titles:
        return {
            "restricted": [],
            "all_clear": False,
            "safe_response": (
                "I don't want to guess. I can forward this to customer service for review."
            ),
        }

    if restricted:
        titles = ", ".join(restricted[:3])
        url = fac.website_url if fac else ""
        msg = (
            f"One or more books on the order may not be accepted by "
            f"{facility_name or 'that facility'}: {titles}. "
            "This may be why the shipment was returned."
        )
        if url:
            msg += f" Official facility mail rules: {url}."
        msg += " I can suggest similar allowed alternatives from our catalog."
        return {
            "restricted": restricted,
            "all_clear": False,
            "safe_response": msg,
        }

    return {
        "restricted": [],
        "all_clear": True,
        "safe_response": (
            "The books appear acceptable for that facility based on the guidelines on file."
        ),
    }
