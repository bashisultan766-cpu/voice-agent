"""
Base classes for all v2 tools.

Design contract:
- BaseTool.execute() NEVER raises — all errors return ToolResult(success=False).
- ToolResult.data must conform to ai.common.schemas.ToolResponse format.
- voice_summary is what the TTS engine speaks to the caller (keep it short).
- state_update is a shallow dict patched onto SessionState after the turn.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any, Optional

from pydantic import BaseModel

if TYPE_CHECKING:
    from ..tenant.schema import AgentConfig
    from ..state.schema import SessionState


class ToolContext(BaseModel):
    """Runtime context injected into every tool call."""

    session_id: str
    agent_id: str
    call_sid: str
    from_number: str
    agent_config: Any   # AgentConfig at runtime — Any to avoid circular imports
    session_state: Any  # SessionState at runtime

    model_config = {"arbitrary_types_allowed": True}


class ToolResult(BaseModel):
    """Unified return type from every tool."""

    success: bool
    data: dict[str, Any]           # Must contain {success, message, data, error}
    voice_summary: str             # Spoken to the caller — 1-2 sentences max
    error: Optional[str] = None
    state_update: Optional[dict[str, Any]] = None  # Shallow patch to SessionState


class BaseTool(ABC):
    """
    Abstract base for all v2 tools.

    Subclasses must set:
        name        — matches OpenAI function name (snake_case)
        description — shown to the LLM
        parameters  — JSON Schema object (OpenAI function parameters)

    And implement:
        async execute(args, context) → ToolResult
    """

    name: str = ""
    description: str = ""
    parameters: dict[str, Any] = {}

    @abstractmethod
    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult: ...

    def to_openai_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }

    # ── Convenience factory for error results ─────────────────────────────────

    @staticmethod
    def error_result(
        voice_summary: str,
        error: str,
        message: str = "",
    ) -> ToolResult:
        return ToolResult(
            success=False,
            data={
                "success": False,
                "message": message or error,
                "data": None,
                "error": error,
            },
            voice_summary=voice_summary,
            error=error,
        )
