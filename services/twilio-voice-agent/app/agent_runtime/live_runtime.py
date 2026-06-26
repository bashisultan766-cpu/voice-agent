"""
Live runtime identity — resolves active turn handler.
"""
from __future__ import annotations

from .llm_tool_runtime import RUNTIME_MODE as LLM_TOOL_RUNTIME_MODE


def resolve_live_turn_handler(settings=None) -> str:
    """
    Return the active live WebSocket turn handler label.

    Priority: voice_commerce_runtime > orchestrator > llm_tool_runtime.
    """
    from ..config import get_settings
    from ..runtime.voice_commerce_runtime import RUNTIME_MODE as COMMERCE_MODE, voice_commerce_enabled
    from ..orchestrator.runtime import RUNTIME_MODE as ORCHESTRATOR_MODE

    s = settings or get_settings()
    if voice_commerce_enabled(s):
        return COMMERCE_MODE
    if getattr(s, "VOICE_ORCHESTRATOR_ENABLED", False):
        return ORCHESTRATOR_MODE
    return LLM_TOOL_RUNTIME_MODE
