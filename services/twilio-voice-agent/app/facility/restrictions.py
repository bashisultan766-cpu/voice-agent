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
    """
    Check a book title against restrictions.

    Returns a restriction reason string if restricted, else None.
    """
    data = _load_restrictions()
    norm_title = _normalize(title)

    restricted_titles = [_normalize(t) for t in data.get("restricted_titles", [])]
    if norm_title in restricted_titles:
        return "title_restricted"

    keywords = [_normalize(k) for k in data.get("restricted_keywords", [])]
    for kw in keywords:
        if kw in norm_title:
            return f"keyword_match:{kw}"

    if facility_name:
        facility_notes = data.get("facility_notes", {})
        for fname, note in facility_notes.items():
            if _normalize(fname) in _normalize(facility_name):
                if isinstance(note, list):
                    for n in note:
                        if _normalize(n) in norm_title:
                            return f"facility_specific_note:{n}"

    return None


def check_order_restrictions(
    book_titles: list[str],
    facility_name: str = "",
) -> dict:
    """
    Check all books on an order against facility restrictions.

    Returns {restricted: list[str], all_clear: bool, safe_response: str}
    """
    data = _load_restrictions()
    restricted = []
    for title in book_titles:
        reason = check_book_restriction(title, facility_name)
        if reason:
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
        return {
            "restricted": restricted,
            "all_clear": False,
            "safe_response": (
                "One of the books on the order may not be accepted by the facility. "
                "I can forward this to customer service for review."
            ),
        }

    return {
        "restricted": [],
        "all_clear": True,
        "safe_response": (
            "The books appear acceptable for that facility based on the information I have."
        ),
    }
