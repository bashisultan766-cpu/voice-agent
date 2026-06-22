"""
Local cache repositories for Shopify data.

Primary store: Redis (via session_store helpers).
Fallback: in-memory dict (single-process, no persistence).

Redis key layout:
  sync:customer:phone:{normalized_phone}  — CachedCustomer JSON
  sync:product:isbn:{isbn}                — CachedProduct JSON
  sync:product:id:{product_id}            — CachedProduct JSON
  sync:order:num:{order_number}           — CachedOrder JSON
  sync:order:recent:{normalized_phone}    — CachedOrder JSON (most recent)

TTLs are intentionally short — webhooks push fresh data; cache is a
read-through layer, not a source of truth.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Optional

from ..state.session_store import cache_get, cache_set, cache_delete

logger = logging.getLogger(__name__)

_CUSTOMER_TTL = 3600        # 1 hour
_PRODUCT_TTL = 1800         # 30 minutes
_ORDER_TTL = 900            # 15 minutes
_PHONE_DIGITS = re.compile(r"\D")
_NON_WORD = re.compile(r"[^\w\s]")
_SPACES = re.compile(r"\s+")


def _normalize_title_key(title: str) -> str:
    """Normalize a product title to a cache key string."""
    t = (title or "").lower().strip()
    t = _NON_WORD.sub("", t)
    t = _SPACES.sub("_", t)
    return t[:100]


def _norm_phone(raw: str) -> str:
    return _PHONE_DIGITS.sub("", raw or "")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Cached data models ─────────────────────────────────────────────────────────

@dataclass
class CachedCustomer:
    customer_id: str
    normalized_phone: str
    display_name: str
    email_masked: str
    last_order_number: str = ""
    updated_at: str = ""

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "CachedCustomer":
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class CachedProduct:
    product_id: str
    title: str
    handle: str
    isbn: str = ""
    author: str = ""
    variant_id: str = ""
    price: str = ""
    currency: str = "USD"
    available: bool = True
    updated_at: str = ""

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "CachedProduct":
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class CachedOrder:
    order_id: str
    order_number: str
    customer_id: str = ""
    normalized_phone: str = ""
    email_masked: str = ""
    financial_status: str = ""
    fulfillment_status: str = ""
    tracking_summary: str = ""
    refund_count: int = 0
    line_items_summary: str = ""
    updated_at: str = ""

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "CachedOrder":
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


# ── Repository classes ─────────────────────────────────────────────────────────

class CustomerCache:
    """Redis-backed cache of Shopify customers keyed by phone number."""

    async def get_by_phone(self, phone: str) -> Optional[CachedCustomer]:
        norm = _norm_phone(phone)
        if not norm:
            return None
        data = await cache_get(f"sync:customer:phone:{norm}")
        if not data:
            return None
        try:
            return CachedCustomer.from_dict(data)
        except Exception as exc:
            logger.warning("Corrupt customer cache for phone %s…: %s", norm[:4], exc)
            return None

    async def set(self, customer: CachedCustomer) -> None:
        customer.updated_at = _now_iso()
        await cache_set(
            f"sync:customer:phone:{customer.normalized_phone}",
            customer.to_dict(),
            _CUSTOMER_TTL,
        )

    async def delete(self, phone: str) -> None:
        norm = _norm_phone(phone)
        if norm:
            await cache_delete(f"sync:customer:phone:{norm}")


class ProductCache:
    """
    Redis-backed cache of Shopify products.

    Keys:
      sync:product:isbn:{isbn}          — by ISBN-13 or ISBN-10
      sync:product:id:{gid}             — by Shopify product GID
      sync:product:title:{norm_title}   — by normalized title (exact match)
      sync:product:handle:{handle}      — by Shopify URL handle (exact match)
    """

    async def get_by_isbn(self, isbn: str) -> Optional[CachedProduct]:
        if not isbn:
            return None
        data = await cache_get(f"sync:product:isbn:{isbn}")
        if not data:
            return None
        try:
            return CachedProduct.from_dict(data)
        except Exception as exc:
            logger.warning("Corrupt product cache for isbn=%s: %s", isbn, exc)
            return None

    async def get_by_id(self, product_id: str) -> Optional[CachedProduct]:
        if not product_id:
            return None
        data = await cache_get(f"sync:product:id:{product_id}")
        if not data:
            return None
        try:
            return CachedProduct.from_dict(data)
        except Exception as exc:
            logger.warning("Corrupt product cache for id=%s: %s", product_id, exc)
            return None

    async def get_by_title(self, title: str) -> Optional[CachedProduct]:
        """Exact normalized-title lookup."""
        key = _normalize_title_key(title)
        if not key:
            return None
        data = await cache_get(f"sync:product:title:{key}")
        if not data:
            return None
        try:
            return CachedProduct.from_dict(data)
        except Exception as exc:
            logger.warning("Corrupt product cache for title=%r: %s", key, exc)
            return None

    async def get_by_handle(self, handle: str) -> Optional[CachedProduct]:
        """Exact Shopify handle lookup."""
        h = (handle or "").lower().strip()
        if not h:
            return None
        data = await cache_get(f"sync:product:handle:{h}")
        if not data:
            return None
        try:
            return CachedProduct.from_dict(data)
        except Exception as exc:
            logger.warning("Corrupt product cache for handle=%r: %s", h, exc)
            return None

    async def set(self, product: CachedProduct) -> None:
        product.updated_at = _now_iso()
        d = product.to_dict()
        if product.isbn:
            await cache_set(f"sync:product:isbn:{product.isbn}", d, _PRODUCT_TTL)
        await cache_set(f"sync:product:id:{product.product_id}", d, _PRODUCT_TTL)
        if product.title:
            key = _normalize_title_key(product.title)
            if key:
                await cache_set(f"sync:product:title:{key}", d, _PRODUCT_TTL)
        if product.handle:
            h = product.handle.lower().strip()
            if h:
                await cache_set(f"sync:product:handle:{h}", d, _PRODUCT_TTL)

    async def delete(self, product_id: str) -> None:
        if product_id:
            await cache_delete(f"sync:product:id:{product_id}")


class OrderCache:
    """
    Redis-backed cache of Shopify orders.

    Keys:
      sync:order:num:{order_number}      — by display order number (e.g. "1042")
      sync:order:recent:{phone}          — most recent order for a phone number
      sync:order:gid:{shopify_order_gid} — by Shopify order GID (for refund lookup)
    """

    async def get_by_number(self, order_number: str) -> Optional[CachedOrder]:
        norm_num = order_number.lstrip("#").strip()
        if not norm_num:
            return None
        data = await cache_get(f"sync:order:num:{norm_num}")
        if not data:
            return None
        try:
            return CachedOrder.from_dict(data)
        except Exception as exc:
            logger.warning("Corrupt order cache for #%s: %s", norm_num, exc)
            return None

    async def get_recent_by_phone(self, phone: str) -> Optional[CachedOrder]:
        norm = _norm_phone(phone)
        if not norm:
            return None
        data = await cache_get(f"sync:order:recent:{norm}")
        if not data:
            return None
        try:
            return CachedOrder.from_dict(data)
        except Exception as exc:
            logger.warning("Corrupt recent-order cache for phone %s…: %s", norm[:4], exc)
            return None

    async def get_by_shopify_id(self, shopify_order_id: str) -> Optional[CachedOrder]:
        """
        Look up by numeric Shopify order ID or full GID.

        Shopify refund webhooks include ``order_id`` as a numeric database ID
        (e.g. ``987654321``), not the display order name (e.g. ``#1042``).
        This method accepts either form.
        """
        sid = str(shopify_order_id).strip()
        if not sid:
            return None
        gid = sid if sid.startswith("gid://") else f"gid://shopify/Order/{sid}"
        data = await cache_get(f"sync:order:gid:{gid}")
        if not data:
            return None
        try:
            return CachedOrder.from_dict(data)
        except Exception as exc:
            logger.warning("Corrupt order cache for gid=%s: %s", gid, exc)
            return None

    async def set(self, order: CachedOrder) -> None:
        order.updated_at = _now_iso()
        d = order.to_dict()
        norm_num = order.order_number.lstrip("#").strip()
        if norm_num:
            await cache_set(f"sync:order:num:{norm_num}", d, _ORDER_TTL)
        if order.normalized_phone:
            await cache_set(f"sync:order:recent:{order.normalized_phone}", d, _ORDER_TTL)
        if order.order_id:
            await cache_set(f"sync:order:gid:{order.order_id}", d, _ORDER_TTL)

    async def delete(self, order_number: str) -> None:
        norm_num = order_number.lstrip("#").strip()
        if norm_num:
            await cache_delete(f"sync:order:num:{norm_num}")
