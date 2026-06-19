from __future__ import annotations
from typing import Any, Dict, List
from app.tools.base import BaseTool, ToolContext
from app.integrations.shopify import get_shopify_client


class CheckoutTool(BaseTool):
    name = "checkout"
    description = (
        "Create a Shopify checkout/payment link for one or more products. "
        "Requires a customer email and the product variant IDs. "
        "Returns a checkout URL to send to the customer."
    )
    parameters = {
        "type": "object",
        "properties": {
            "customer_email": {
                "type": "string",
                "description": "Customer's email address to send the checkout link",
            },
            "items": {
                "type": "array",
                "description": "List of items to include in the checkout",
                "items": {
                    "type": "object",
                    "properties": {
                        "variant_id": {
                            "type": "string",
                            "description": "Shopify product variant ID",
                        },
                        "quantity": {
                            "type": "integer",
                            "description": "Quantity to purchase",
                            "default": 1,
                        },
                        "title": {
                            "type": "string",
                            "description": "Product title (for display only)",
                        },
                    },
                    "required": ["variant_id"],
                },
            },
            "note": {
                "type": "string",
                "description": "Optional note to attach to the order",
            },
        },
        "required": ["customer_email", "items"],
    }

    async def execute(self, ctx: ToolContext, **kwargs: Any) -> Dict[str, Any]:
        if not ctx.shopify_store_url or not ctx.shopify_api_token:
            return {"error": "Shopify credentials not configured."}

        customer_email: str = kwargs.get("customer_email", "")
        items: List[Dict] = kwargs.get("items", [])
        note: str = kwargs.get("note", "Order placed via AI voice agent")

        if not customer_email:
            return {"error": "Customer email is required to create a checkout link."}
        if not items:
            return {"error": "At least one item is required."}

        client = get_shopify_client(ctx.shopify_store_url, ctx.shopify_api_token)

        # For single item, use storefront cart permalink (faster, no API call)
        if len(items) == 1:
            variant_id = str(items[0]["variant_id"]).split("/")[-1]
            qty = int(items[0].get("quantity", 1))
            checkout_url = client.cart_permalink(variant_id, qty)
            return {
                "success": True,
                "checkout_url": checkout_url,
                "customer_email": customer_email,
                "message": f"Checkout link created for {customer_email}.",
            }

        # Multi-item: create draft order
        line_items = [
            {
                "variant_id": int(str(it["variant_id"]).split("/")[-1]),
                "quantity": int(it.get("quantity", 1)),
            }
            for it in items
        ]
        draft = await client.create_draft_order(line_items, customer_email, note=note)
        checkout_url = draft.get("invoice_url") or draft.get("order_status_url", "")

        return {
            "success": True,
            "draft_order_id": draft.get("id"),
            "checkout_url": checkout_url,
            "total_price": draft.get("total_price"),
            "customer_email": customer_email,
            "message": f"Checkout link created. Total: {draft.get('total_price', '')}",
        }
