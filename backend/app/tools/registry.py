from __future__ import annotations
import json
from typing import Any, Dict, List, Optional
from app.tools.base import BaseTool, ToolContext
from app.tools.product_search import ProductSearchTool
from app.tools.order_lookup import OrderLookupTool
from app.tools.checkout import CheckoutTool
from app.tools.email_tool import EmailTool
from app.tools.customer_lookup import CustomerLookupTool
from app.tools.recommendation import RecommendationTool
from app.tools.conversation_state import ConversationStateTool

ALL_TOOLS: Dict[str, BaseTool] = {
    "product_search": ProductSearchTool(),
    "order_lookup": OrderLookupTool(),
    "checkout": CheckoutTool(),
    "email": EmailTool(),
    "customer_lookup": CustomerLookupTool(),
    "recommendation": RecommendationTool(),
    "conversation_state": ConversationStateTool(),
}


class ToolRegistry:
    def __init__(self, enabled: List[str]):
        self._tools: Dict[str, BaseTool] = {
            name: tool for name, tool in ALL_TOOLS.items() if name in enabled
        }

    def schemas(self) -> List[Dict[str, Any]]:
        return [t.openai_schema() for t in self._tools.values()]

    async def execute(self, name: str, ctx: ToolContext, args: Dict[str, Any]) -> str:
        tool = self._tools.get(name)
        if not tool:
            return json.dumps({"error": f"Tool '{name}' not available."})
        result = await tool.timed_execute(ctx, **args)
        return json.dumps(result, default=str)

    def has(self, name: str) -> bool:
        return name in self._tools


def build_registry(enabled_tools: Optional[List[str]] = None) -> ToolRegistry:
    if enabled_tools is None:
        enabled_tools = list(ALL_TOOLS.keys())
    return ToolRegistry(enabled_tools)
