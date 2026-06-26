"""Production safety net from live defect patterns (v4.13)."""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_SERVICE_ROOT = Path(__file__).resolve().parent.parent.parent
_DEFAULT_PATTERNS_PATH = _SERVICE_ROOT / "app/data/live_defect_patterns.json"


@dataclass(frozen=True)
class DefectMatch:
    classification: str
    pattern: str
    matched_text: str = ""


@lru_cache(maxsize=1)
def _load_patterns() -> tuple[tuple[re.Pattern, str], ...]:
    path = _DEFAULT_PATTERNS_PATH
    compiled: list[tuple[re.Pattern, str]] = []
    if not path.is_file():
        return tuple()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logger.warning("defect_patterns_load_failed")
        return tuple()
    for entry in raw:
        pat = entry.get("pattern", "")
        cls = entry.get("classification", "")
        flags_s = entry.get("flags", "i")
        if not pat or not cls:
            continue
        flags = re.I if "i" in flags_s else 0
        try:
            compiled.append((re.compile(pat, flags), cls))
        except re.error:
            continue
    return tuple(compiled)


def match_defect_pattern(text: str) -> Optional[DefectMatch]:
    """Return classification if text matches a known live defect pattern."""
    t = (text or "").strip()
    if not t:
        return None
    for regex, classification in _load_patterns():
        m = regex.search(t)
        if m:
            return DefectMatch(
                classification=classification,
                pattern=regex.pattern,
                matched_text=m.group(0),
            )
    return None


def clear_defect_pattern_cache() -> None:
    _load_patterns.cache_clear()
