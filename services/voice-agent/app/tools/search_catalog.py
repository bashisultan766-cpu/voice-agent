"""
Tool: search_catalog
Version: v2

Purpose:
    Search the SureShot Books catalog by title, author, ISBN, SKU, or keyword.
    Returns matching products with an explicit stock_status — never guesses availability.

    stock_status is always one of:
        "in_stock"     inventory_qty > 0
        "out_of_stock" inventory_qty == 0, no backorder tag
        "backorder"    inventory_qty == 0, Shopify tag "backorder" present

    Three-layer architecture (same pattern as get_order v2):

        ┌──────────────────────────────────────────────────────────┐
        │  SearchCatalogTool.execute()                             │
        │    ↓ validates input                                     │
        │    ↓ calls _resolve_search()                             │
        │         ├─ MOCK:  MockCatalogRepository  (active)        │
        │         └─ REAL:  ShopifyCatalogClient   (disabled)      │
        │    ↓ _format_voice_summary()                             │
        │    ↓ returns ToolResult with suggested_response          │
        └──────────────────────────────────────────────────────────┘
"""
from __future__ import annotations

import logging
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

from .base import BaseTool, ToolContext, ToolResult
from .registry import registry

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 1 — Domain models
# ─────────────────────────────────────────────────────────────────────────────

StockStatus = Literal["in_stock", "out_of_stock", "backorder"]
SearchType = Literal["title", "author", "isbn", "sku", "general"]


class CatalogProduct(BaseModel):
    product_id: str
    variant_id: str
    title: str
    author: Optional[str] = None
    price_usd: str
    stock_status: StockStatus
    inventory_qty: int
    tags: list[str] = Field(default_factory=list)
    source: Literal["mock", "shopify"] = "mock"


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 2 — Request model
# ─────────────────────────────────────────────────────────────────────────────


class SearchCatalogRequest(BaseModel):
    query: str = Field(..., description="Title, author name, ISBN, SKU, or keyword")
    search_type: SearchType = "general"
    limit: int = Field(5, ge=1, le=10)

    @field_validator("query")
    @classmethod
    def clean_query(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("query cannot be empty")
        return v


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 3 — Business logic (pure, zero I/O)
# ─────────────────────────────────────────────────────────────────────────────


def _derive_stock_status(inventory_qty: int, tags: list[str]) -> StockStatus:
    """
    Data-driven only — never guesses.
      inventory_qty > 0              → "in_stock"
      inventory_qty == 0 + "backorder" tag → "backorder"
      inventory_qty == 0, no tag    → "out_of_stock"
    """
    if inventory_qty > 0:
        return "in_stock"
    if "backorder" in [t.lower().strip() for t in tags]:
        return "backorder"
    return "out_of_stock"


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 4 — Voice summary formatter (pure function, zero I/O)
# ─────────────────────────────────────────────────────────────────────────────


def _product_voice_line(p: CatalogProduct) -> str:
    by = f" by {p.author}" if p.author else ""
    price = f"${p.price_usd}"
    if p.stock_status == "in_stock":
        return f"{p.title}{by}, {price}, in stock"
    if p.stock_status == "backorder":
        return f"{p.title}{by}, {price}, available to order — ships when restocked"
    return f"{p.title}{by}, {price}, currently out of stock"


def _format_voice_summary(products: list[CatalogProduct], query: str) -> str:
    if not products:
        return (
            f"I wasn't able to find anything for \"{query}\" in our catalog. "
            "Would you like me to connect you with our team?"
        )
    first_line = _product_voice_line(products[0])
    if len(products) == 1:
        return f"I found {first_line}."
    others = len(products) - 1
    return (
        f"I found {first_line}. "
        f"I also have {others} other result{'s' if others > 1 else ''}."
    )


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 5 — MOCK LAYER  (replace with ShopifyCatalogClient when ready)
#
# Catalog covers all three stock_status values:
#   prod_001, 002, 004  →  in_stock     (inventory_qty > 0)
#   prod_003            →  out_of_stock (inventory_qty = 0, no backorder tag)
#   prod_005            →  backorder    (inventory_qty = 0, tag "backorder")
# ─────────────────────────────────────────────────────────────────────────────

_MOCK_CATALOG: list[CatalogProduct] = [
    CatalogProduct(
        product_id="prod_001",
        variant_id="var_001",
        title="A Thug's Heartbeat: Rocko's Street Justice",
        author="J.M. Benjamin",
        price_usd="15.95",
        stock_status=_derive_stock_status(133, []),
        inventory_qty=133,
        source="mock",
    ),
    CatalogProduct(
        product_id="prod_002",
        variant_id="var_002",
        title="Hood Rich",
        author="Glory",
        price_usd="14.99",
        stock_status=_derive_stock_status(47, []),
        inventory_qty=47,
        source="mock",
    ),
    CatalogProduct(
        product_id="prod_003",
        variant_id="var_003",
        title="Street Love",
        author="Omar Tyree",
        price_usd="16.50",
        stock_status=_derive_stock_status(0, []),
        inventory_qty=0,
        source="mock",
    ),
    CatalogProduct(
        product_id="prod_004",
        variant_id="var_004",
        title="Tears of a Hustler",
        author="Silk White",
        price_usd="12.99",
        stock_status=_derive_stock_status(88, []),
        inventory_qty=88,
        source="mock",
    ),
    CatalogProduct(
        product_id="prod_005",
        variant_id="var_005",
        title="The Coldest Winter Ever",
        author="Sister Souljah",
        price_usd="13.99",
        stock_status=_derive_stock_status(0, ["backorder"]),
        inventory_qty=0,
        tags=["backorder"],
        source="mock",
    ),
]


class MockCatalogRepository:
    @staticmethod
    def search(query: str, search_type: str, limit: int = 5) -> list[CatalogProduct]:
        q = query.lower().strip()

        if search_type == "author":
            matches = [
                p for p in _MOCK_CATALOG
                if p.author and q in p.author.lower()
            ]
        elif search_type in ("isbn", "sku"):
            matches = [
                p for p in _MOCK_CATALOG
                if q in p.product_id.lower() or q in p.variant_id.lower()
            ]
        else:  # "title" or "general"
            matches = [
                p for p in _MOCK_CATALOG
                if q in p.title.lower()
                or (p.author and q in p.author.lower())
                or any(q in t.lower() for t in p.tags)
            ]

        return matches[:limit]


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 6 — SHOPIFY API PLACEHOLDER (disabled — interface contract only)
# ─────────────────────────────────────────────────────────────────────────────


def _map_shopify_product(raw: dict[str, Any]) -> CatalogProduct:
    """Map a raw Shopify Admin API product dict → CatalogProduct. NOT YET ACTIVE."""
    variants = raw.get("variants", [{}])
    first_variant = variants[0] if variants else {}
    inventory_qty = int(first_variant.get("inventory_quantity") or 0)
    raw_tags = [t.strip() for t in raw.get("tags", "").split(",") if t.strip()]
    return CatalogProduct(
        product_id=str(raw.get("id", "")),
        variant_id=str(first_variant.get("id", "")),
        title=raw.get("title", ""),
        author=raw.get("vendor") or None,
        price_usd=str(first_variant.get("price", "0.00")),
        stock_status=_derive_stock_status(inventory_qty, raw_tags),
        inventory_qty=inventory_qty,
        tags=raw_tags,
        source="shopify",
    )


class ShopifyCatalogClient:
    """Interface contract for the real Shopify catalog search. NOT YET IMPLEMENTED."""

    def __init__(self, domain: str, access_token: str) -> None:
        self._domain = domain
        self._access_token = access_token

    async def search(
        self, query: str, search_type: str, limit: int = 5
    ) -> list[CatalogProduct]:
        raise NotImplementedError(
            "ShopifyCatalogClient.search() is not yet implemented. "
            "Keep SHOPIFY_USE_MOCK=True or implement this method."
        )


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 7 — Resolver
# ─────────────────────────────────────────────────────────────────────────────


async def _resolve_search(
    query: str,
    search_type: str,
    limit: int,
    shopify_domain: Optional[str],
    shopify_access_token: Optional[str],
) -> list[CatalogProduct]:
    """Route to mock or real Shopify based on credential presence."""
    use_real = bool(shopify_domain and shopify_access_token)

    if use_real:
        try:
            client = ShopifyCatalogClient(shopify_domain, shopify_access_token)  # type: ignore[arg-type]
            return await client.search(query, search_type, limit)
        except NotImplementedError:
            logger.warning(
                "ShopifyCatalogClient not implemented — falling back to mock for %r",
                query,
            )
        except Exception as exc:
            logger.error(
                "ShopifyCatalogClient.search(%r) failed: %s — falling back to mock",
                query, exc,
            )

    logger.debug("search_catalog: using mock data for query %r", query)
    return MockCatalogRepository.search(query, search_type, limit)


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 8 — Tool class
# ─────────────────────────────────────────────────────────────────────────────


class SearchCatalogTool(BaseTool):
    name = "search_catalog"
    description = (
        "Search the SureShot Books catalog by title, author, ISBN, SKU, or keyword. "
        "Returns stock_status for each result: 'in_stock', 'out_of_stock', or 'backorder'. "
        "Call this when the customer asks about a book, author, price, or availability."
    )
    parameters = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Book title, author name, ISBN, SKU, or keyword",
            },
            "search_type": {
                "type": "string",
                "enum": ["title", "author", "isbn", "sku", "general"],
                "description": "How to interpret the query. Use 'general' when unsure.",
                "default": "general",
            },
            "limit": {
                "type": "integer",
                "description": "Maximum results to return (1–10). Default 5.",
                "default": 5,
            },
        },
        "required": ["query"],
    }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        try:
            req = SearchCatalogRequest(**args)
        except Exception as exc:
            return self.error_result(
                voice_summary="What title or author are you looking for?",
                error=f"Invalid input: {exc}",
            )

        try:
            products = await _resolve_search(
                query=req.query,
                search_type=req.search_type,
                limit=req.limit,
                shopify_domain=context.agent_config.shopify_domain,
                shopify_access_token=context.agent_config.shopify_access_token,
            )
        except Exception as exc:
            logger.error(
                "search_catalog(%r) fetch error: %s", req.query, exc, exc_info=True
            )
            return self.error_result(
                voice_summary=(
                    "I'm having trouble searching the catalog right now. "
                    "Please try again in a moment."
                ),
                error=f"Catalog search failed: {exc}",
            )

        found = bool(products)
        voice_summary = _format_voice_summary(products, req.query)
        product_dicts = [p.model_dump() for p in products]

        message = (
            f"Found {len(products)} result{'s' if len(products) != 1 else ''} "
            f"for \"{req.query}\"."
            if found
            else f"No results found for \"{req.query}\"."
        )

        logger.info(
            "search_catalog: query=%r type=%s results=%d",
            req.query, req.search_type, len(products),
        )

        state_update: Optional[dict[str, Any]] = None
        if found:
            state_update = {
                "conversation_state": "PRODUCT_SEARCH",
                "selected_product": product_dicts[0],
                "selected_variant_id": products[0].variant_id,
            }

        return ToolResult(
            success=True,
            data={
                "success": True,
                "message": message,
                "suggested_response": voice_summary,
                "data": {
                    "found": found,
                    "count": len(products),
                    "query": req.query,
                    "search_type": req.search_type,
                    "products": product_dicts,
                },
                "error": None,
            },
            voice_summary=voice_summary,
            state_update=state_update,
        )


# ── Self-register ─────────────────────────────────────────────────────────────

registry.register(SearchCatalogTool())
