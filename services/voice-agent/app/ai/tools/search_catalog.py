from typing import Any

from .base import BaseTool, ToolContext, ToolResult
from .registry import registry


class SearchCatalogTool(BaseTool):
    name = "search_catalog"
    description = (
        "Search the store catalog for products by title, author, ISBN, or keyword. "
        "Call this when the customer asks about a specific book, author, or what is in stock."
    )
    parameters = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Book title, author name, or ISBN to search for",
            },
            "search_type": {
                "type": "string",
                "enum": ["title", "author", "isbn", "general"],
                "description": "How to interpret the query",
                "default": "general",
            },
        },
        "required": ["query"],
    }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        query = args.get("query", "").strip()
        search_type = args.get("search_type", "general")

        if not query:
            return ToolResult(
                success=False,
                data={},
                voice_summary="What book or author are you looking for?",
                error="Empty query",
            )

        from ...shopify import get_shopify_client
        client = get_shopify_client(
            domain=context.agent_config.shopify_domain,
            access_token=context.agent_config.shopify_access_token,
        )

        products = await client.search_products(query, search_type)

        if not products:
            return ToolResult(
                success=True,
                data={"found": False, "products": []},
                voice_summary=(
                    f"I'm sorry, I wasn't able to find {query} in our catalog. "
                    "Would you like me to connect you with our team?"
                ),
            )

        product_dicts = [p.model_dump() for p in products]
        first = products[0]
        summary = f"I found {first.voice_summary}."
        if len(products) > 1:
            others = len(products) - 1
            summary += f" I also have {others} other result{'s' if others > 1 else ''}."

        return ToolResult(
            success=True,
            data={"found": True, "count": len(products), "products": product_dicts},
            voice_summary=summary,
            state_update={
                "conversation_state": "PRODUCT_SEARCH",
                "selected_product": product_dicts[0],
                "selected_variant_id": first.variant_id,
            },
        )


registry.register(SearchCatalogTool())
