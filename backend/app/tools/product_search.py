from __future__ import annotations
from typing import Any, Dict
from app.tools.base import BaseTool, ToolContext
from app.integrations.shopify import get_shopify_client


class ProductSearchTool(BaseTool):
    name = "product_search"
    description = (
        "Search the Shopify store for products matching a query. "
        "Returns product titles, prices, availability, and variant IDs for checkout."
    )
    parameters = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Product name, category, or keywords to search for",
            },
            "limit": {
                "type": "integer",
                "description": "Max number of results (default 5, max 10)",
                "default": 5,
            },
        },
        "required": ["query"],
    }

    async def execute(self, ctx: ToolContext, **kwargs: Any) -> Dict[str, Any]:
        if not ctx.shopify_store_url or not ctx.shopify_api_token:
            return {"error": "Shopify credentials not configured for this agent."}

        query: str = kwargs.get("query", "")
        limit: int = min(int(kwargs.get("limit", 5)), 10)

        client = get_shopify_client(ctx.shopify_store_url, ctx.shopify_api_token)
        products = await client.search_products(query, limit=limit)

        if not products:
            return {"found": False, "message": f"No products found for '{query}'."}

        return {
            "found": True,
            "count": len(products),
            "products": products,
        }
