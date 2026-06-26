"""Commerce demo hardening flag (v4.14.6)."""
from __future__ import annotations

import os
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..config import Settings


def is_commerce_demo_hardening(settings: "Settings | None" = None) -> bool:
    """Return True when deterministic commerce resolver should win over LLM."""
    env_val = os.environ.get("VOICE_COMMERCE_DEMO_HARDENING")
    if env_val is not None:
        return env_val.strip().lower() in ("true", "1", "yes")
    if settings is None:
        from ..config import get_settings
        settings = get_settings()
    explicit = getattr(settings, "VOICE_COMMERCE_DEMO_HARDENING", None)
    if explicit is not None:
        return bool(explicit)
    return settings.VOICE_AGENT_RUNTIME_MODE == "main_llm_agent"
