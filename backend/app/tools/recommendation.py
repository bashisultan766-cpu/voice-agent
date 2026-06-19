from __future__ import annotations
from typing import Any, Dict, List
from app.tools.base import BaseTool, ToolContext
from app.integrations.shopify import get_shopify_client


class RecommendationTool(BaseTool):
    name = "recommendation"
    description = (
        "Get product recommendations based on what the customer is interested in. "
        "Searches across categories and returns curated suggestions with reasons."
    )
    parameters = {
        "type": "object",
        "properties": {
            "interest": {
                "type": "string",
                "description": "Customer's interest or category (e.g. 'mystery books', 'fiction', 'bestsellers')",
            },
            "budget": {
                "type": "string",
                "description": "Optional budget range (e.g. 'under $20', '$10-$30')",
            },
            "limit": {
                "type": "integer",
                "description": "Number of recommendations (default 3)",
                "default": 3,
            },
        },
        "required": ["interest"],
    }

    async def execute(self, ctx: ToolContext, **kwargs: Any) -> Dict[str, Any]:
        if not ctx.shopify_store_url or not ctx.shopify_api_token:
            return {"error": "Shopify credentials not configured."}

        interest: str = kwargs.get("interest", "")
        limit: int = min(int(kwargs.get("limit", 3)), 5)

        client = get_shopify_client(ctx.shopify_store_url, ctx.shopify_api_token)
        products = await client.search_products(interest, limit=limit * 2)

        # Filter to available items only
        available = [p for p in products if p.get("available", False)]
        recommendations = available[:limit] or products[:limit]

        if not recommendations:
            return {"found": False, "message": f"No recommendations found for '{interest}'."}

        return {
            "found": True,
            "recommendations": [
                {
                    "title": p["title"],
                    "price": p["price"],
                    "variant_id": p["variants"][0]["id"] if p.get("variants") else None,
                    "available": p.get("available", False),
                }
                for p in recommendations
            ],
        }
