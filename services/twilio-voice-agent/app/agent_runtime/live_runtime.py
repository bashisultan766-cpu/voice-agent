"""
Live runtime identity — resolves active turn handler (orchestrator or llm_tool_runtime).
"""
from __future__ import annotations

from .llm_tool_runtime import RUNTIME_MODE as LLM_TOOL_RUNTIME_MODE


def resolve_live_turn_handler(settings=None) -> str:
    """
    Return the active live WebSocket turn handler label.

    When ``VOICE_ORCHESTRATOR_ENABLED`` is true, returns ``orchestrator``.
    Otherwise returns ``llm_tool_runtime`` (default production path).
    """
    from ..config import get_settings
    from ..orchestrator.runtime import RUNTIME_MODE as ORCHESTRATOR_MODE

    s = settings or get_settings()
    if getattr(s, "VOICE_ORCHESTRATOR_ENABLED", False):
        return ORCHESTRATOR_MODE
    return LLM_TOOL_RUNTIME_MODE
