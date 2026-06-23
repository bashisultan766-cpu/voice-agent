"""Eric system prompt file loader (v4.13).

Loads prompt from disk at first use; falls back to inline policy if missing.
Never logs full prompt text.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_SERVICE_ROOT = Path(__file__).resolve().parent.parent.parent
_DEFAULT_REL_PATH = "app/data/eric_system_prompt.md"

_loaded_from_file: Optional[bool] = None
_prompt_version: str = "inline"
_text_cache: dict[str, str] = {}


def _resolve_prompt_path(path: str) -> Path:
    p = Path(path)
    if p.is_absolute():
        return p
    return _SERVICE_ROOT / path


def load_eric_system_prompt_text(
    path: Optional[str] = None,
    version: Optional[str] = None,
) -> str:
    """Load Eric master prompt from file or fallback to inline policy."""
    global _loaded_from_file, _prompt_version

    from ..config import get_settings
    s = get_settings()
    rel = path or getattr(s, "ERIC_SYSTEM_PROMPT_PATH", _DEFAULT_REL_PATH)
    ver = version or getattr(s, "ERIC_SYSTEM_PROMPT_VERSION", "v1")
    cache_key = f"{rel}:{ver}"
    if cache_key in _text_cache:
        return _text_cache[cache_key]

    full_path = _resolve_prompt_path(rel)

    if full_path.is_file():
        try:
            text = full_path.read_text(encoding="utf-8").strip()
            if len(text) > 50:
                _loaded_from_file = True
                _prompt_version = ver
                _text_cache[cache_key] = text
                logger.info(
                    "eric_prompt_loaded source=file version=%s chars=%d",
                    ver, len(text),
                )
                return text
        except OSError:
            logger.warning("eric_prompt_load_failed path=%s", rel)

    from .eric_master_policy import _build_inline_master_prompt
    text = _build_inline_master_prompt()
    _loaded_from_file = False
    _prompt_version = "inline"
    _text_cache[cache_key] = text
    logger.info("eric_prompt_loaded source=inline_fallback chars=%d", len(text))
    return text


def get_prompt_load_status() -> dict:
    """Safe status for check_agent_runtime — no prompt text."""
    load_eric_system_prompt_text()
    return {
        "loaded_from_file": bool(_loaded_from_file),
        "version": _prompt_version,
        "chars": len(load_eric_system_prompt_text()),
    }


def clear_prompt_cache() -> None:
    _text_cache.clear()
    global _loaded_from_file, _prompt_version
    _loaded_from_file = None
    _prompt_version = "inline"
