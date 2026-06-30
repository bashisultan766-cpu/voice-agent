"""
Live runtime identity — canonical voice commerce handler only.
"""
from __future__ import annotations


def resolve_live_turn_handler(settings=None) -> str:
    """Return the active live WebSocket turn handler label."""
    from ..config import get_settings
    from ..runtime.voice_commerce_runtime import RUNTIME_MODE, voice_commerce_enabled
    from ..voice_os_v2.runtime import RUNTIME_MODE as V2_MODE
    from ..voice_os_v2.runtime import voice_os_v2_enabled

    s = settings or get_settings()
    if voice_os_v2_enabled(s):
        return V2_MODE
    if not voice_commerce_enabled(s):
        raise RuntimeError(
            "VOICE_COMMERCE_RUNTIME_ENABLED must be true — legacy runtimes removed"
        )
    return RUNTIME_MODE
