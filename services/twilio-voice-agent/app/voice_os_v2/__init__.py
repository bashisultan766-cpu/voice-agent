"""
VOICE_AGENT_OS_V2.1 — production conversational voice core.
"""
from __future__ import annotations

from .runtime import RUNTIME_MODE, get_turn_controller, voice_os_v2_enabled
from .types import Plan, TurnResult

__version__ = "2.1"

__all__ = [
    "RUNTIME_MODE",
    "Plan",
    "TurnResult",
    "__version__",
    "get_turn_controller",
    "voice_os_v2_enabled",
]
