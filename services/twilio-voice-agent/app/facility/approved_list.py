"""
Facility approved list loader and matcher (v4.8).

Data source: app/data/facility_approved_list.csv
Columns: facility_name, city, state, approved, notes

Never claims approval without a positive list match.
"""
from __future__ import annotations

import csv
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_DATA_PATH = Path(__file__).parent.parent / "data" / "facility_approved_list.csv"

_FACILITY_LIST: list[dict] = []
_LOADED = False


def _normalize(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _load_list() -> list[dict]:
    global _FACILITY_LIST, _LOADED
    if _LOADED:
        return _FACILITY_LIST
    try:
        if _DATA_PATH.exists():
            with open(_DATA_PATH, newline="", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                _FACILITY_LIST = [row for row in reader]
        else:
            logger.warning("facility_approved_list.csv not found at %s", _DATA_PATH)
    except Exception as exc:
        logger.error("Failed to load facility_approved_list.csv: %s", exc)
    _LOADED = True
    return _FACILITY_LIST


@dataclass
class FacilityLookupResult:
    found: bool = False
    approved: Optional[bool] = None  # None = unknown, True = approved, False = not approved
    facility_name: str = ""
    city: str = ""
    state: str = ""
    notes: str = ""
    safe_response: str = ""


def lookup_facility(
    name: str,
    city: str = "",
    state: str = "",
) -> FacilityLookupResult:
    """
    Look up a facility in the approved list.

    Matching: normalized name must match. City/state narrow the match if provided.
    Returns a FacilityLookupResult with safe_response pre-built.
    """
    rows = _load_list()
    norm_name = _normalize(name)
    norm_city = _normalize(city)
    norm_state = _normalize(state)

    candidates = []
    for row in rows:
        if _normalize(row.get("facility_name", "")) == norm_name:
            candidates.append(row)

    if not candidates:
        result = FacilityLookupResult(found=False, facility_name=name)
        result.safe_response = (
            "I don't want to guess. I can forward this to customer service for confirmation."
        )
        return result

    # Narrow by city/state if given
    match = candidates[0]
    if norm_city or norm_state:
        for row in candidates:
            rc = _normalize(row.get("city", ""))
            rs = _normalize(row.get("state", ""))
            if (not norm_city or rc == norm_city) and (not norm_state or rs == norm_state):
                match = row
                break

    is_approved = str(match.get("approved", "")).lower() in ("true", "yes", "1")
    result = FacilityLookupResult(
        found=True,
        approved=is_approved,
        facility_name=match.get("facility_name", name),
        city=match.get("city", ""),
        state=match.get("state", ""),
        notes=match.get("notes", ""),
    )
    if is_approved:
        result.safe_response = "Yes, SureShot Books is approved to ship to that facility."
    else:
        result.safe_response = "I do not see that facility as approved for shipping."
    return result
