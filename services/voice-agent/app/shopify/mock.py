import uuid
from typing import Optional

from .client import CheckoutResult, OrderResult, ProductResult, ShopifyClient

_CATALOG: list[ProductResult] = [
    ProductResult(
        product_id="prod_001",
        variant_id="var_001",
        title="A Thug's Heartbeat: Rocko's Street Justice",
        author="J.M. Benjamin",
        price_usd="15.95",
        in_stock=True,
        inventory_qty=133,
        voice_summary="A Thug's Heartbeat by J.M. Benjamin, $15.95, in stock",
    ),
    ProductResult(
        product_id="prod_002",
        variant_id="var_002",
        title="Hood Rich",
        author="Glory",
        price_usd="14.99",
        in_stock=True,
        inventory_qty=47,
        voice_summary="Hood Rich by Glory, $14.99, in stock",
    ),
    ProductResult(
        product_id="prod_003",
        variant_id="var_003",
        title="Street Love",
        author="Omar Tyree",
        price_usd="16.50",
        in_stock=False,
        inventory_qty=0,
        voice_summary="Street Love by Omar Tyree, $16.50, currently out of stock",
    ),
    ProductResult(
        product_id="prod_004",
        variant_id="var_004",
        title="Tears of a Hustler",
        author="Silk White",
        price_usd="12.99",
        in_stock=True,
        inventory_qty=88,
        voice_summary="Tears of a Hustler by Silk White, $12.99, in stock",
    ),
]


class MockShopifyClient(ShopifyClient):
    async def search_products(
        self,
        query: str,
        search_type: str = "general",
        limit: int = 5,
    ) -> list[ProductResult]:
        q = query.lower()
        matches = [
            p for p in _CATALOG
            if q in p.title.lower() or (p.author and q in p.author.lower())
        ]
        # If no match, return first 2 as suggestions
        return (matches or _CATALOG[:2])[:limit]

    async def get_order(self, order_number: str) -> Optional[OrderResult]:
        return OrderResult(
            found=True,
            order_number=order_number,
            status="paid",
            fulfillment_status="fulfilled",
            subtotal="15.95",
            shipping_cost="4.99",
            shipping_method="Standard Shipping",
            tracking_number="9400111899223456789012",
            items=["A Thug's Heartbeat x1"],
            can_cancel=False,
            cancellation_reason="Order already shipped",
            voice_summary=(
                f"Order {order_number} has shipped. "
                "The subtotal was $15.95 plus $4.99 for standard shipping."
            ),
        )

    async def create_draft_order(
        self,
        email: str,
        items: list[dict],
        customer_phone: Optional[str] = None,
        note: Optional[str] = None,
    ) -> CheckoutResult:
        order_name = f"#D{uuid.uuid4().hex[:4].upper()}"
        url = f"https://mock-store.myshopify.com/checkout/{uuid.uuid4().hex[:8]}"
        return CheckoutResult(
            success=True,
            order_name=order_name,
            checkout_url=url,
            email_sent=True,
            voice_summary=f"Your payment link has been sent to {email}. Please check your inbox.",
        )
