from __future__ import annotations
from typing import Any, Dict
from app.tools.base import BaseTool, ToolContext
from app.integrations.shopify import get_shopify_client


class OrderLookupTool(BaseTool):
    name = "order_lookup"
    description = (
        "Look up a Shopify order by order number or customer email. "
        "Returns order status, line items, tracking info, and fulfillment status."
    )
    parameters = {
        "type": "object",
        "properties": {
            "order_name": {
                "type": "string",
                "description": "Order number (e.g. #1234 or 1234)",
            },
            "email": {
                "type": "string",
                "description": "Customer email to look up recent orders",
            },
        },
    }

    async def execute(self, ctx: ToolContext, **kwargs: Any) -> Dict[str, Any]:
        if not ctx.shopify_store_url or not ctx.shopify_api_token:
            return {"error": "Shopify credentials not configured."}

        client = get_shopify_client(ctx.shopify_store_url, ctx.shopify_api_token)
        order_name: str = kwargs.get("order_name", "")
        email: str = kwargs.get("email", "")

        if order_name:
            order = await client.get_order_by_name(order_name.lstrip("#"))
            if not order:
                return {"found": False, "message": f"No order found with number {order_name}."}
            return {"found": True, "order": _summarize_order(order)}

        if email:
            orders = await client.get_orders_by_email(email)
            if not orders:
                return {"found": False, "message": f"No orders found for {email}."}
            return {"found": True, "orders": [_summarize_order(o) for o in orders]}

        return {"error": "Provide order_name or email to look up an order."}


def _summarize_order(order: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "name": order.get("name"),
        "status": order.get("financial_status"),
        "fulfillment_status": order.get("fulfillment_status"),
        "total": order.get("total_price"),
        "currency": order.get("currency"),
        "created_at": order.get("created_at"),
        "email": order.get("email"),
        "line_items": [
            {"title": li["title"], "quantity": li["quantity"], "price": li["price"]}
            for li in order.get("line_items", [])[:5]
        ],
        "tracking_url": (
            order.get("fulfillments", [{}])[0].get("tracking_url")
            if order.get("fulfillments")
            else None
        ),
    }
