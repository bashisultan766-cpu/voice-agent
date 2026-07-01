"""
Master system prompt loader for the LLM-first tool runtime.

Loads ONE master prompt file (``app/data/agent_master_system_prompt.md``) and
exposes it safely:

* The file may be long — there is no small character cap enforced in code.
* The file is validated to exist; a missing/empty file raises a clear error
  (it never crashes at import time, only when a load is attempted).
* Approximate token counts are computed (tiktoken when available, else a
  heuristic) so the runtime can decide whether to send the whole prompt.
* The prompt is split into labelled sections so that, if the full prompt is too
  large for the selected model, the runtime can send only the required sections
  per turn — without ever silently dropping privacy, payment, or tool-safety
  rules (those are always-included).

No secrets are read or logged here.
"""
from __future__ import annotations

import hashlib
import logging
import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Iterable, Optional

logger = logging.getLogger(__name__)

PROMPT_VERSION_LABEL = "v4.20-elevenlabs-aligned"

# Default location relative to the ``app`` package root.
_DEFAULT_REL_PATH = "data/agent_master_system_prompt.md"

# Map raw markdown headings -> canonical section keys.
_HEADING_TO_SECTION: dict[str, str] = {
    "persona": "persona",
    "domain boundaries": "domain_boundaries",
    "voice style": "voice_style",
    "tool usage policy": "tool_rules",
    "privacy and verification": "privacy_rules",
    "payment rules": "payment_rules",
    "product order refund rules": "product_order_refund_rules",
    "product, order, and refund rules": "product_order_refund_rules",
    "facility rules": "facility_rules",
    "escalation rules": "escalation_rules",
    "business rules": "business_rules",
}

# Sections that must ALWAYS be sent regardless of size budget. These encode the
# safety-critical rules the agent can never operate without.
ALWAYS_INCLUDED_SECTIONS: tuple[str, ...] = (
    "persona",
    "domain_boundaries",
    "voice_style",
    "tool_rules",
    "privacy_rules",
    "payment_rules",
    "product_order_refund_rules",
    "facility_rules",
    "escalation_rules",
)


class MasterPromptError(RuntimeError):
    """Raised when the master prompt cannot be loaded or is empty."""


@dataclass
class MasterPrompt:
    """A parsed master prompt: full text plus labelled sections."""

    text: str
    path: str
    sections: dict[str, str] = field(default_factory=dict)
    approx_tokens: int = 0

    def section(self, key: str) -> str:
        return self.sections.get(key, "")

    def assemble(
        self,
        *,
        extra_sections: Iterable[str] = (),
        max_tokens: Optional[int] = None,
    ) -> str:
        """
        Return a system prompt string.

        If ``max_tokens`` is None or the full prompt fits, return the full text.
        Otherwise return ALWAYS_INCLUDED_SECTIONS plus any requested
        ``extra_sections``, preserving document order. Safety sections are never
        dropped.
        """
        if max_tokens is None or self.approx_tokens <= max_tokens:
            return self.text

        wanted: list[str] = list(ALWAYS_INCLUDED_SECTIONS)
        for key in extra_sections:
            if key not in wanted:
                wanted.append(key)

        # Preserve the original document order of sections.
        ordered = [k for k in self.sections if k in wanted]
        parts = [self.sections[k] for k in ordered if self.sections.get(k)]
        assembled = "\n\n".join(parts).strip()
        logger.info(
            "master_prompt_assembled mode=sectioned sections=%d approx_full_tokens=%d "
            "budget=%d",
            len(parts), self.approx_tokens, max_tokens,
        )
        return assembled or self.text


def approx_token_count(text: str) -> int:
    """Best-effort token count. Uses tiktoken if installed, else a heuristic."""
    if not text:
        return 0
    try:
        import tiktoken  # type: ignore

        enc = tiktoken.get_encoding("cl100k_base")
        return len(enc.encode(text))
    except Exception:  # noqa: BLE001 — tiktoken optional; never fail the call
        # Heuristic: ~4 chars per token for English prose.
        return max(1, len(text) // 4)


def _split_sections(text: str) -> dict[str, str]:
    """Split the markdown into canonical sections keyed by heading."""
    sections: dict[str, str] = {}
    current_key: Optional[str] = None
    buf: list[str] = []

    def _flush() -> None:
        if current_key and buf:
            body = "\n".join(buf).strip()
            if body:
                sections[current_key] = body

    for line in text.splitlines():
        m = re.match(r"^##\s+(.*?)\s*$", line)
        if m:
            _flush()
            heading = m.group(1).strip().lower()
            current_key = _HEADING_TO_SECTION.get(heading)
            # Keep the heading line in the section body for clarity.
            buf = [line] if current_key else []
        elif current_key:
            buf.append(line)
    _flush()
    return sections


def _resolve_path(path: Optional[str]) -> Path:
    if path:
        return Path(path)
    # app/agent_runtime/master_prompt.py -> app/data/agent_master_system_prompt.md
    return Path(__file__).resolve().parent.parent / _DEFAULT_REL_PATH


def load_master_prompt(path: Optional[str] = None) -> MasterPrompt:
    """
    Load and parse the master prompt. Raises MasterPromptError on missing/empty.

    Not cached so callers can reload after edits; use ``get_master_prompt`` for a
    cached singleton in the hot path.
    """
    p = _resolve_path(path)
    if not p.exists():
        raise MasterPromptError(
            f"Master system prompt not found at {p}. "
            "Create app/data/agent_master_system_prompt.md."
        )
    text = p.read_text(encoding="utf-8").strip()
    if not text:
        raise MasterPromptError(f"Master system prompt at {p} is empty.")

    sections = _split_sections(text)
    tokens = approx_token_count(text)
    logger.info(
        "master_prompt_loaded chars=%d approx_tokens=%d sections=%d path=%s",
        len(text), tokens, len(sections), p.name,
    )
    return MasterPrompt(
        text=text,
        path=str(p),
        sections=sections,
        approx_tokens=tokens,
    )


@lru_cache(maxsize=2)
def get_master_prompt(path: Optional[str] = None) -> MasterPrompt:
    """Cached master prompt for the hot path. Raises on missing/empty."""
    return load_master_prompt(path)


def prompt_startup_diagnostic(path: Optional[str] = None) -> dict[str, int | str]:
    """
    Safe startup diagnostic: hash, section count, char count, version label.
    Never logs or returns prompt body or secrets.
    """
    mp = load_master_prompt(path)
    digest = hashlib.sha256(mp.text.encode("utf-8")).hexdigest()[:12]
    return {
        "version": PROMPT_VERSION_LABEL,
        "hash": digest,
        "chars": len(mp.text),
        "sections": len(mp.sections),
        "approx_tokens": mp.approx_tokens,
        "path": Path(mp.path).name,
    }
