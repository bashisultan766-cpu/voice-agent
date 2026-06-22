"""
Tests for app/sync/repositories.py — CachedCustomer, CachedProduct, CachedOrder
and their Redis-backed cache repositories.

All tests use the in-memory fallback (no live Redis required).
"""
from __future__ import annotations

import os
import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.sync.repositories import (
    CachedCustomer,
    CachedProduct,
    CachedOrder,
    CustomerCache,
    ProductCache,
    OrderCache,
    _norm_phone,
)


# ── Dataclass serialisation ───────────────────────────────────────────────────

class TestCachedCustomer:
    def test_to_dict_round_trip(self):
        c = CachedCustomer(
            customer_id="gid://shopify/Customer/1",
            normalized_phone="15551234567",
            display_name="Alice Smith",
            email_masked="a***e@example.com",
            last_order_number="#1001",
        )
        d = c.to_dict()
        c2 = CachedCustomer.from_dict(d)
        assert c2.customer_id == c.customer_id
        assert c2.display_name == "Alice Smith"
        assert c2.email_masked == "a***e@example.com"

    def test_from_dict_ignores_unknown_keys(self):
        d = {
            "customer_id": "gid://shopify/Customer/2",
            "normalized_phone": "15552222222",
            "display_name": "Bob",
            "email_masked": "b***@test.com",
            "unknown_field": "should be ignored",
        }
        c = CachedCustomer.from_dict(d)
        assert c.customer_id == "gid://shopify/Customer/2"

    def test_email_never_stored_raw(self):
        c = CachedCustomer(
            customer_id="x",
            normalized_phone="15551234567",
            display_name="Alice",
            email_masked="a***e@example.com",
        )
        d = c.to_dict()
        assert "alice@example.com" not in str(d)


class TestCachedProduct:
    def test_round_trip(self):
        p = CachedProduct(
            product_id="gid://shopify/Product/42",
            title="Dune",
            handle="dune",
            isbn="9780441013593",
            author="Frank Herbert",
            price="9.99",
            available=True,
        )
        p2 = CachedProduct.from_dict(p.to_dict())
        assert p2.isbn == "9780441013593"
        assert p2.author == "Frank Herbert"
        assert p2.available is True

    def test_defaults(self):
        p = CachedProduct(product_id="x", title="A Book", handle="a-book")
        assert p.isbn == ""
        assert p.available is True
        assert p.currency == "USD"


class TestCachedOrder:
    def test_round_trip(self):
        o = CachedOrder(
            order_id="gid://shopify/Order/99",
            order_number="#1042",
            financial_status="paid",
            fulfillment_status="fulfilled",
            refund_count=1,
            line_items_summary="1x Dune",
        )
        o2 = CachedOrder.from_dict(o.to_dict())
        assert o2.order_number == "#1042"
        assert o2.refund_count == 1
        assert o2.financial_status == "paid"

    def test_email_always_masked(self):
        o = CachedOrder(
            order_id="x",
            order_number="#1",
            email_masked="t***t@test.com",
        )
        d = o.to_dict()
        assert "test@test.com" not in str(d)
        assert "t***t@test.com" in str(d)


# ── _norm_phone ───────────────────────────────────────────────────────────────

class TestNormPhone:
    def test_strips_plus(self):
        assert _norm_phone("+15551234567") == "15551234567"

    def test_strips_dashes(self):
        assert _norm_phone("555-123-4567") == "5551234567"

    def test_empty_string(self):
        assert _norm_phone("") == ""

    def test_none_safe(self):
        assert _norm_phone(None) == ""


# ── CustomerCache ─────────────────────────────────────────────────────────────

class TestCustomerCache:
    async def test_set_and_get_by_phone(self):
        cache = CustomerCache()
        customer = CachedCustomer(
            customer_id="gid://shopify/Customer/10",
            normalized_phone="15559990000",
            display_name="Eve",
            email_masked="e***e@test.com",
        )
        await cache.set(customer)
        result = await cache.get_by_phone("+15559990000")
        assert result is not None
        assert result.display_name == "Eve"

    async def test_get_missing_returns_none(self):
        cache = CustomerCache()
        result = await cache.get_by_phone("+19999999999")
        assert result is None

    async def test_empty_phone_returns_none(self):
        cache = CustomerCache()
        result = await cache.get_by_phone("")
        assert result is None

    async def test_set_adds_updated_at(self):
        cache = CustomerCache()
        customer = CachedCustomer(
            customer_id="gid://shopify/Customer/11",
            normalized_phone="15558880001",
            display_name="Frank",
            email_masked="f***k@test.com",
        )
        await cache.set(customer)
        assert customer.updated_at != ""

    async def test_delete_removes_entry(self):
        cache = CustomerCache()
        customer = CachedCustomer(
            customer_id="gid://shopify/Customer/12",
            normalized_phone="15557770002",
            display_name="Grace",
            email_masked="g***e@test.com",
        )
        await cache.set(customer)
        await cache.delete("+15557770002")
        result = await cache.get_by_phone("+15557770002")
        assert result is None


# ── ProductCache ──────────────────────────────────────────────────────────────

class TestProductCache:
    async def test_set_and_get_by_isbn(self):
        cache = ProductCache()
        product = CachedProduct(
            product_id="gid://shopify/Product/50",
            title="Foundation",
            handle="foundation",
            isbn="9780553293357",
        )
        await cache.set(product)
        result = await cache.get_by_isbn("9780553293357")
        assert result is not None
        assert result.title == "Foundation"

    async def test_set_and_get_by_id(self):
        cache = ProductCache()
        product = CachedProduct(
            product_id="gid://shopify/Product/51",
            title="Neuromancer",
            handle="neuromancer",
        )
        await cache.set(product)
        result = await cache.get_by_id("gid://shopify/Product/51")
        assert result is not None
        assert result.title == "Neuromancer"

    async def test_get_missing_isbn_returns_none(self):
        cache = ProductCache()
        result = await cache.get_by_isbn("0000000000000")
        assert result is None

    async def test_get_missing_id_returns_none(self):
        cache = ProductCache()
        result = await cache.get_by_id("gid://shopify/Product/9999999")
        assert result is None


# ── OrderCache ────────────────────────────────────────────────────────────────

class TestOrderCache:
    async def test_set_and_get_by_number(self):
        cache = OrderCache()
        order = CachedOrder(
            order_id="gid://shopify/Order/100",
            order_number="#2001",
            financial_status="paid",
        )
        await cache.set(order)
        result = await cache.get_by_number("#2001")
        assert result is not None
        assert result.financial_status == "paid"

    async def test_get_by_number_without_hash(self):
        cache = OrderCache()
        order = CachedOrder(
            order_id="gid://shopify/Order/101",
            order_number="#2002",
        )
        await cache.set(order)
        # Can query with or without '#'
        result = await cache.get_by_number("2002")
        assert result is not None

    async def test_set_and_get_recent_by_phone(self):
        cache = OrderCache()
        order = CachedOrder(
            order_id="gid://shopify/Order/102",
            order_number="#2003",
            normalized_phone="15553330003",
            financial_status="pending",
        )
        await cache.set(order)
        result = await cache.get_recent_by_phone("+15553330003")
        assert result is not None
        assert result.order_number == "#2003"

    async def test_get_missing_order_returns_none(self):
        cache = OrderCache()
        result = await cache.get_by_number("#99999")
        assert result is None

    async def test_delete_removes_order(self):
        cache = OrderCache()
        order = CachedOrder(
            order_id="gid://shopify/Order/103",
            order_number="#2004",
        )
        await cache.set(order)
        await cache.delete("#2004")
        result = await cache.get_by_number("#2004")
        assert result is None
