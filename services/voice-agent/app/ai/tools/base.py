from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any, Optional

from pydantic import BaseModel

if TYPE_CHECKING:
    from ...tenant.schema import AgentConfig
    from ...state.schema import SessionState


class ToolContext(BaseModel):
    session_id: str
    agent_id: str
    call_sid: str
    from_number: str
    agent_config: Any   # AgentConfig — typed at runtime to avoid circular imports
    session_state: Any  # SessionState

    model_config = {"arbitrary_types_allowed": True}


class ToolResult(BaseModel):
    success: bool
    data: dict[str, Any]
    voice_summary: str
    error: Optional[str] = None
    state_update: Optional[dict[str, Any]] = None  # mutations to apply to SessionState


class BaseTool(ABC):
    name: str = ""
    description: str = ""
    parameters: dict[str, Any] = {}  # JSON Schema for OpenAI function calling

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
