from __future__ import annotations
from typing import Any, Dict
from app.tools.base import BaseTool, ToolContext
from app.core.cache import cache_get, cache_set


class ConversationStateTool(BaseTool):
    name = "conversation_state"
    description = (
        "Read or write key-value state for the current conversation. "
        "Use to track collected info like customer email, chosen product, or intent."
    )
    parameters = {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["get", "set"],
                "description": "Whether to get or set a state value",
            },
            "key": {
                "type": "string",
                "description": "State key (e.g. 'customer_email', 'selected_product')",
            },
            "value": {
                "type": "string",
                "description": "Value to store (only required for 'set' action)",
            },
        },
        "required": ["action", "key"],
    }

    def _state_key(self, ctx: ToolContext, key: str) -> str:
        return f"conv:state:{ctx.call_sid}:{key}"

    async def execute(self, ctx: ToolContext, **kwargs: Any) -> Dict[str, Any]:
        action: str = kwargs.get("action", "get")
        key: str = kwargs.get("key", "")
        value: str = kwargs.get("value", "")

        if not key:
            return {"error": "Key is required."}

        cache_key = self._state_key(ctx, key)

        if action == "get":
            stored = await cache_get(cache_key)
            return {"key": key, "value": stored}

        if action == "set":
            await cache_set(cache_key, value, ttl=3600)
            return {"key": key, "value": value, "saved": True}

        return {"error": f"Unknown action: {action}"}
