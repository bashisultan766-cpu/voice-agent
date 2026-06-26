"""Model selection for orchestrator stages."""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..config import Settings
    from .types import SupervisorResult

_STAGE_SUPERVISOR = "supervisor"
_STAGE_PLANNER = "planner"
_STAGE_COMPOSER = "composer"


def select_model(
    stage: str,
    supervisor: "SupervisorResult | None" = None,
    *,
    settings: "Settings | None" = None,
    use_fallback: bool = False,
    complex_planner: bool = False,
) -> str:
    from ..config import get_settings

    s = settings or get_settings()
    if use_fallback:
        return (getattr(s, "OPENAI_FALLBACK_MODEL", "") or s.OPENAI_FAST_MODEL or s.OPENAI_MODEL).strip()

    fast = (getattr(s, "OPENAI_FAST_MODEL", "") or "gpt-4o-mini").strip()
    strong = (getattr(s, "OPENAI_STRONG_MODEL", "") or s.OPENAI_MODEL or fast).strip()

    if stage == _STAGE_SUPERVISOR:
        override = (getattr(s, "VOICE_SUPERVISOR_MODEL", "") or "").strip()
        return override or fast

    if stage == _STAGE_PLANNER:
        if complex_planner:
            return strong
        return fast

    if stage == _STAGE_COMPOSER:
        override = (getattr(s, "VOICE_FINAL_MODEL", "") or "").strip()
        return override or fast

    intent = getattr(supervisor, "intent", "") if supervisor else ""
    if intent in ("product_search",) and supervisor and "compare" in (supervisor.reason or ""):
        return strong
    if intent in ("smalltalk", "faq", "identity_email_collection"):
        return fast
    if intent in ("checkout_payment", "order_status", "refund_status"):
        return fast
    return fast
