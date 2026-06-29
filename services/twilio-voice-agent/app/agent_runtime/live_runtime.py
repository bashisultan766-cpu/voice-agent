"""
Live runtime identity — canonical voice commerce handler only.
"""
from __future__ import annotations


def resolve_live_turn_handler(settings=None) -> str:
    """Return the active live WebSocket turn handler label."""
    from ..config import get_settings
    from ..runtime.voice_commerce_runtime import RUNTIME_MODE, voice_commerce_enabled

    s = settings or get_settings()
    if not voice_commerce_enabled(s):
        raise RuntimeError(
            "VOICE_COMMERCE_RUNTIME_ENABLED must be true — legacy runtimes removed"
        )
    return RUNTIME_MODE
