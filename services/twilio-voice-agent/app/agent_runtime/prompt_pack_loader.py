"""Eric prompt pack loader (v4.15.1).

Loads sorted markdown files from a prompt pack directory, concatenates into one
system prompt, caches with file mtimes, and reloads when files change.
Never logs full prompt text.
"""
from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_SERVICE_ROOT = Path(__file__).resolve().parent.parent.parent
_DEFAULT_PACK_DIR = "app/data/prompt_pack"

_REQUIRED_FILES = (
    "00_eric_core_identity.md",
    "10_store_business_rules.md",
    "20_dialogue_style.md",
    "30_tool_use_policy.md",
    "40_payment_safety_policy.md",
    "50_examples_and_edge_cases.md",
)

_cache: dict[str, "PromptPackSnapshot"] = {}
_last_cache_hit: bool = False


@dataclass
class PromptPackSnapshot:
    text: str
    prompt_hash: str
    prompt_chars: int
    files_loaded: list[str] = field(default_factory=list)
    file_chars: dict[str, int] = field(default_factory=dict)
    file_mtimes: dict[str, float] = field(default_factory=dict)


def _resolve_pack_dir(path: str) -> Path:
    p = Path(path)
    if p.is_absolute():
        return p
    return _SERVICE_ROOT / path


def _compute_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _collect_pack_files(pack_dir: Path) -> list[Path]:
    if not pack_dir.is_dir():
        return []
    return sorted(pack_dir.glob("*.md"))


def _load_pack_from_dir(
    pack_dir: Path,
    *,
    require_all: bool,
    max_chars: int,
) -> PromptPackSnapshot:
    files = _collect_pack_files(pack_dir)
    names = [f.name for f in files]

    if require_all:
        missing = [name for name in _REQUIRED_FILES if name not in names]
        if missing:
            raise FileNotFoundError(
                f"Prompt pack missing required files: {', '.join(missing)}"
            )

    parts: list[str] = []
    files_loaded: list[str] = []
    file_chars: dict[str, int] = {}
    file_mtimes: dict[str, float] = {}

    for fp in files:
        text = fp.read_text(encoding="utf-8").strip()
        if not text:
            continue
        parts.append(text)
        files_loaded.append(fp.name)
        file_chars[fp.name] = len(text)
        file_mtimes[fp.name] = fp.stat().st_mtime
        logger.info("prompt_pack_file_loaded name=%s chars=%d", fp.name, len(text))

    combined = "\n\n".join(parts).strip()
    if len(combined) > max_chars:
        raise ValueError(
            f"Prompt pack exceeds ERIC_PROMPT_MAX_CHARS ({len(combined)} > {max_chars})"
        )

    prompt_hash = _compute_hash(combined)
    snapshot = PromptPackSnapshot(
        text=combined,
        prompt_hash=prompt_hash,
        prompt_chars=len(combined),
        files_loaded=files_loaded,
        file_chars=file_chars,
        file_mtimes=file_mtimes,
    )
    logger.info(
        "prompt_pack_loaded files=%d chars=%d hash=%s",
        len(files_loaded),
        snapshot.prompt_chars,
        prompt_hash,
    )
    logger.info("prompt_pack_validation_ok")
    return snapshot


def _pack_changed(pack_dir: Path, cached: PromptPackSnapshot) -> bool:
    for name, mtime in cached.file_mtimes.items():
        fp = pack_dir / name
        if not fp.is_file() or fp.stat().st_mtime != mtime:
            return True
    current = {f.name for f in _collect_pack_files(pack_dir)}
    if set(cached.file_mtimes.keys()) != current:
        return True
    return False


def load_prompt_pack(
    pack_dir: Optional[str] = None,
    *,
    require_all: Optional[bool] = None,
    max_chars: Optional[int] = None,
    force_reload: bool = False,
) -> PromptPackSnapshot:
    """Load prompt pack from directory with mtime-based cache."""
    global _last_cache_hit
    from ..config import get_settings

    s = get_settings()
    rel = pack_dir or getattr(s, "ERIC_PROMPT_PACK_DIR", _DEFAULT_PACK_DIR)
    req = require_all if require_all is not None else getattr(
        s, "ERIC_PROMPT_PACK_REQUIRE_ALL", True
    )
    limit = max_chars if max_chars is not None else getattr(
        s, "ERIC_PROMPT_MAX_CHARS", 60000
    )

    full_dir = _resolve_pack_dir(rel)
    cache_key = f"{rel}:{req}:{limit}"

    if not force_reload and cache_key in _cache:
        cached = _cache[cache_key]
        if not _pack_changed(full_dir, cached):
            _last_cache_hit = True
            return cached
        logger.info("prompt_pack_reload_detected hash=%s", cached.prompt_hash)

    _last_cache_hit = False
    snapshot = _load_pack_from_dir(full_dir, require_all=req, max_chars=limit)
    _cache[cache_key] = snapshot
    return snapshot


def load_prompt_pack_text(
    pack_dir: Optional[str] = None,
    *,
    force_reload: bool = False,
) -> str:
    """Return concatenated prompt pack text."""
    return load_prompt_pack(pack_dir, force_reload=force_reload).text


def get_prompt_pack_status() -> dict:
    """Safe status for scripts — no prompt text."""
    from ..config import get_settings

    s = get_settings()
    enabled = getattr(s, "ERIC_PROMPT_PACK_ENABLED", True)
    if not enabled:
        return {"enabled": False, "source": "legacy_single_file"}

    try:
        snap = load_prompt_pack()
        return {
            "enabled": True,
            "source": "prompt_pack",
            "files": snap.files_loaded,
            "file_chars": snap.file_chars,
            "prompt_chars": snap.prompt_chars,
            "prompt_hash": snap.prompt_hash,
            "cache_hit": _last_cache_hit,
        }
    except Exception as exc:
        return {"enabled": True, "source": "prompt_pack", "error": str(exc)[:120]}


def clear_prompt_pack_cache() -> None:
    global _last_cache_hit
    _cache.clear()
    _last_cache_hit = False
