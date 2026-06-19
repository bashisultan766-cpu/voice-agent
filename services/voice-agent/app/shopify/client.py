from abc import ABC, abstractmethod
from typing import Optional

from pydantic import BaseModel


class ProductResult(BaseModel):
    product_id: str
    variant_id: str
    title: str
    author: Optional[str] = None
    price_usd: str
    in_stock: bool
    inventory_qty: int
    voice_summary: str


class OrderResult(BaseModel):
    found: bool
    order_number: str
    status: str
    fulfillment_status: str
    subtotal: str
    shipping_cost: str
    shipping_method: str
    tracking_number: Optional[str]
    items: list[str]
    can_cancel: bool
    cancellation_reason: Optional[str]
    voice_summary: str


class CheckoutResult(BaseModel):
    success: bool
    order_name: str
    checkout_url: str
    email_sent: bool
    voice_summary: str
    error: Optional[str] = None


class ShopifyClient(ABC):
    @abstractmethod
    async def search_products(
        self,
        query: str,
        search_type: str = "general",
        limit: int = 5,
    ) -> list[ProductResult]: ...

    @abstractmethod
    async def get_order(self, order_number: str) -> Optional[OrderResult]: ...

    @abstractmethod
    async def create_draft_order(
        self,
        email: str,
        items: list[dict],
        customer_phone: Optional[str] = None,
        note: Optional[str] = None,
    ) -> CheckoutResult: ...
