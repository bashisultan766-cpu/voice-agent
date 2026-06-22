"""
Client-managed stock overrides (v4.8).

Overrides Shopify availability for titles where the client explicitly knows
the status. Loaded from app/data/stock_overrides.json.

Red River Vengeance is always out_of_stock per client instruction.
"""
from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_DATA_PATH = Path(__file__).parent.parent / "data" / "stock_overrides.json"

_OVERRIDES: dict = {}
_LOADED = False


def _normalize_title(title: str) -> str:
    return re.sub(r"\s+", " ", title.lower().strip())


def _load_overrides() -> dict:
    global _OVERRIDES, _LOADED
    if _LOADED:
        return _OVERRIDES
    try:
        if _DATA_PATH.exists():
            with open(_DATA_PATH, encoding="utf-8") as f:
                raw = json.load(f)
            _OVERRIDES = {_normalize_title(k): v for k, v in raw.items()}
        else:
            logger.warning("stock_overrides.json not found at %s", _DATA_PATH)
    except Exception as exc:
        logger.error("Failed to load stock_overrides.json: %s", exc)
    _LOADED = True
    return _OVERRIDES


def get_stock_override(title: str) -> Optional[dict]:
    """
    Return override dict {status, reason} if this title has a client override, else None.

    status values: out_of_stock | in_stock | backorder
    """
    overrides = _load_overrides()
    normalized = _normalize_title(title)
    return overrides.get(normalized)


def is_out_of_stock_override(title: str) -> bool:
    """Return True if the title is overridden to out_of_stock."""
    override = get_stock_override(title)
    return bool(override and override.get("status") == "out_of_stock")


def apply_stock_override(title: str, shopify_available: bool) -> tuple[bool, str]:
    """
    Apply client override to Shopify availability result.

    Returns (available, status) where status ∈ {in_stock, out_of_stock, backorder, shopify}.
    If override exists, it wins over Shopify.
    """
    override = get_stock_override(title)
    if override:
        status = override.get("status", "out_of_stock")
        available = status == "in_stock"
        logger.info(
            "stock_override_applied title_normalized=%s status=%s",
            _normalize_title(title)[:40],
            status,
        )
        return available, status
    return shopify_available, "in_stock" if shopify_available else "out_of_stock"
