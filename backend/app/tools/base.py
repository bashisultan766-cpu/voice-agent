from __future__ import annotations
import time
from abc import ABC, abstractmethod
from typing import Any, Dict


class ToolContext:
    """Runtime context passed to every tool execution."""

    def __init__(
        self,
        agent_id: str,
        tenant_id: str,
        call_sid: str,
        shopify_store_url: str = "",
        shopify_api_token: str = "",
        openai_api_key: str = "",
        resend_api_key: str = "",
        from_email: str = "",
        conversation_history: list | None = None,
    ):
        self.agent_id = agent_id
        self.tenant_id = tenant_id
        self.call_sid = call_sid
        self.shopify_store_url = shopify_store_url
        self.shopify_api_token = shopify_api_token
        self.openai_api_key = openai_api_key
        self.resend_api_key = resend_api_key
        self.from_email = from_email
        self.conversation_history: list = conversation_history or []


class BaseTool(ABC):
    """All tools extend this base class."""

    name: str
    description: str
    parameters: Dict[str, Any]  # JSON Schema for OpenAI function calling

    @abstractmethod
    async def execute(self, ctx: ToolContext, **kwargs: Any) -> Dict[str, Any]:
        """Execute the tool and return a result dict."""

    def openai_schema(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }

    async def timed_execute(self, ctx: ToolContext, **kwargs: Any) -> Dict[str, Any]:
        start = time.monotonic()
        result = await self.execute(ctx, **kwargs)
        elapsed_ms = int((time.monotonic() - start) * 1000)
        result["_latency_ms"] = elapsed_ms
        return result
