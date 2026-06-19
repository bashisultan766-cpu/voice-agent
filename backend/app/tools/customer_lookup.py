from __future__ import annotations
from typing import Any, Dict
from app.tools.base import BaseTool, ToolContext
from app.integrations.shopify import get_shopify_client


class CustomerLookupTool(BaseTool):
    name = "customer_lookup"
    description = (
        "Look up a customer in the Shopify store by email. "
        "Returns customer name, order history count, and account details."
    )
    parameters = {
        "type": "object",
        "properties": {
            "email": {
                "type": "string",
                "description": "Customer email address to look up",
            }
        },
        "required": ["email"],
    }

    async def execute(self, ctx: ToolContext, **kwargs: Any) -> Dict[str, Any]:
        if not ctx.shopify_store_url or not ctx.shopify_api_token:
            return {"error": "Shopify credentials not configured."}

        email: str = kwargs.get("email", "")
        if not email:
            return {"error": "Email is required."}

        client = get_shopify_client(ctx.shopify_store_url, ctx.shopify_api_token)
        customer = await client.get_customer_by_email(email)

        if not customer:
            return {"found": False, "message": f"No customer found with email {email}."}

        return {
            "found": True,
            "customer": {
                "id": customer.get("id"),
                "first_name": customer.get("first_name"),
                "last_name": customer.get("last_name"),
                "email": customer.get("email"),
                "orders_count": customer.get("orders_count", 0),
                "total_spent": customer.get("total_spent"),
                "accepts_marketing": customer.get("accepts_marketing", False),
                "tags": customer.get("tags", ""),
            },
        }
