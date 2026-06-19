from typing import Any

from .base import BaseTool, ToolContext, ToolResult
from .registry import registry


class GetOrderTool(BaseTool):
    name = "get_order"
    description = (
        "Look up an existing order by order number. "
        "Returns status, items, shipping info, total price, and cancellation eligibility."
    )
    parameters = {
        "type": "object",
        "properties": {
            "order_number": {
                "type": "string",
                "description": "The order number, e.g. '1234' or '#1234'",
            },
        },
        "required": ["order_number"],
    }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        order_number = args.get("order_number", "").strip().lstrip("#").strip()

        if not order_number:
            return ToolResult(
                success=False,
                data={},
                voice_summary="Could you give me your order number? It should be on your confirmation email.",
                error="Empty order number",
            )

        from ...shopify import get_shopify_client
        client = get_shopify_client(
            domain=context.agent_config.shopify_domain,
            access_token=context.agent_config.shopify_access_token,
        )

        order = await client.get_order(order_number)

        if not order or not order.found:
            return ToolResult(
                success=True,
                data={"found": False},
                voice_summary=(
                    f"I wasn't able to find order number {order_number}. "
                    "Could you double-check the number?"
                ),
            )

        return ToolResult(
            success=True,
            data=order.model_dump(),
            voice_summary=order.voice_summary,
        )


registry.register(GetOrderTool())
