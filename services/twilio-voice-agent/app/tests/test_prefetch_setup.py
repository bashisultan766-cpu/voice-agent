"""
Tests for Production Hardening v3.1 — Feature 7:
  Tests for engine.prefetch_on_call_setup().

Verifies that call-setup prefetch:
- Queries CustomerCache and OrderCache (never makes live Shopify calls).
- Populates session.caller_name from cached customer data.
- Populates session.last_order_number from cached recent order.
- Does not overwrite values already set on the session.
- Handles cache miss gracefully (no crash, session unchanged).
- Handles cache errors gracefully.
"""
from __future__ import annotations

import os
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.pipeline.engine import RealtimePipelineEngine
from app.state.models import SessionState
from app.sync.repositories import CachedCustomer, CachedOrder


def _make_session(**kwargs) -> SessionState:
    defaults = dict(
        session_id="s-setup",
        call_sid="CA_SETUP01",
        from_number="+15551234567",
        to_number="+18005551234",
    )
    defaults.update(kwargs)
    return SessionState(**defaults)


def _make_settings():
    from app.config import Settings
    return Settings(OPENAI_API_KEY="test", DEBUG=True)


def _make_customer(name: str = "Alice Smith", phone: str = "15551234567") -> CachedCustomer:
    return CachedCustomer(
        customer_id="gid://shopify/Customer/1",
        normalized_phone=phone,
        display_name=name,
        email_masked="a***e@example.com",
        last_order_number="#1042",
    )


def _make_order(number: str = "#1042", phone: str = "15551234567") -> CachedOrder:
    return CachedOrder(
        order_id="gid://shopify/Order/200",
        order_number=number,
        normalized_phone=phone,
        financial_status="paid",
    )


# ── Customer lookup ───────────────────────────────────────────────────────────

class TestPrefetchCustomer:
    async def test_customer_name_populated_from_cache(self):
        engine = RealtimePipelineEngine(settings=_make_settings())
        session = _make_session()

        mock_customer_cache = AsyncMock()
        mock_customer_cache.get_by_phone = AsyncMock(return_value=_make_customer("Bob Jones"))
        mock_order_cache = AsyncMock()
        mock_order_cache.get_recent_by_phone = AsyncMock(return_value=None)

        with patch("app.sync.repositories.CustomerCache", return_value=mock_customer_cache), \
             patch("app.sync.repositories.OrderCache", return_value=mock_order_cache):
            await engine.prefetch_on_call_setup(session)

        assert session.caller_name == "Bob Jones"

    async def test_customer_lookup_uses_from_number(self):
        engine = RealtimePipelineEngine(settings=_make_settings())
        session = _make_session(from_number="+14445556666")
        called_with = []

        async def spy_get_by_phone(phone):
            called_with.append(phone)
            return None

        mock_customer_cache = AsyncMock()
        mock_customer_cache.get_by_phone = spy_get_by_phone
        mock_order_cache = AsyncMock()
        mock_order_cache.get_recent_by_phone = AsyncMock(return_value=None)

        with patch("app.sync.repositories.CustomerCache", return_value=mock_customer_cache), \
             patch("app.sync.repositories.OrderCache", return_value=mock_order_cache):
            await engine.prefetch_on_call_setup(session)

        assert "+14445556666" in called_with

    async def test_does_not_overwrite_existing_caller_name(self):
        engine = RealtimePipelineEngine(settings=_make_settings())
        session = _make_session(caller_name="Pre-set Name")

        mock_customer_cache = AsyncMock()
        mock_customer_cache.get_by_phone = AsyncMock(
            return_value=_make_customer("Cache Name")
        )
        mock_order_cache = AsyncMock()
        mock_order_cache.get_recent_by_phone = AsyncMock(return_value=None)

        with patch("app.sync.repositories.CustomerCache", return_value=mock_customer_cache), \
             patch("app.sync.repositories.OrderCache", return_value=mock_order_cache):
            await engine.prefetch_on_call_setup(session)

        assert session.caller_name == "Pre-set Name"

    async def test_customer_miss_no_crash(self):
        engine = RealtimePipelineEngine(settings=_make_settings())
        session = _make_session()

        mock_customer_cache = AsyncMock()
        mock_customer_cache.get_by_phone = AsyncMock(return_value=None)
        mock_order_cache = AsyncMock()
        mock_order_cache.get_recent_by_phone = AsyncMock(return_value=None)

        with patch("app.sync.repositories.CustomerCache", return_value=mock_customer_cache), \
             patch("app.sync.repositories.OrderCache", return_value=mock_order_cache):
            await engine.prefetch_on_call_setup(session)

        # No crash, session unchanged
        assert session.caller_name == ""

    async def test_customer_cache_error_no_crash(self):
        engine = RealtimePipelineEngine(settings=_make_settings())
        session = _make_session()

        mock_customer_cache = AsyncMock()
        mock_customer_cache.get_by_phone = AsyncMock(side_effect=Exception("Redis error"))
        mock_order_cache = AsyncMock()
        mock_order_cache.get_recent_by_phone = AsyncMock(return_value=None)

        with patch("app.sync.repositories.CustomerCache", return_value=mock_customer_cache), \
             patch("app.sync.repositories.OrderCache", return_value=mock_order_cache):
            await engine.prefetch_on_call_setup(session)

        # Must not raise
        assert session.caller_name == ""


# ── Order lookup ──────────────────────────────────────────────────────────────

class TestPrefetchOrder:
    async def test_recent_order_populates_last_order_number(self):
        engine = RealtimePipelineEngine(settings=_make_settings())
        session = _make_session()

        mock_customer_cache = AsyncMock()
        mock_customer_cache.get_by_phone = AsyncMock(return_value=None)
        mock_order_cache = AsyncMock()
        mock_order_cache.get_recent_by_phone = AsyncMock(
            return_value=_make_order("#2099")
        )

        with patch("app.sync.repositories.CustomerCache", return_value=mock_customer_cache), \
             patch("app.sync.repositories.OrderCache", return_value=mock_order_cache):
            await engine.prefetch_on_call_setup(session)

        assert session.last_order_number == "#2099"

    async def test_does_not_overwrite_existing_order_number(self):
        engine = RealtimePipelineEngine(settings=_make_settings())
        session = _make_session(last_order_number="#9999")

        mock_customer_cache = AsyncMock()
        mock_customer_cache.get_by_phone = AsyncMock(return_value=None)
        mock_order_cache = AsyncMock()
        mock_order_cache.get_recent_by_phone = AsyncMock(
            return_value=_make_order("#1000")
        )

        with patch("app.sync.repositories.CustomerCache", return_value=mock_customer_cache), \
             patch("app.sync.repositories.OrderCache", return_value=mock_order_cache):
            await engine.prefetch_on_call_setup(session)

        assert session.last_order_number == "#9999"

    async def test_order_miss_no_crash(self):
        engine = RealtimePipelineEngine(settings=_make_settings())
        session = _make_session()

        mock_customer_cache = AsyncMock()
        mock_customer_cache.get_by_phone = AsyncMock(return_value=None)
        mock_order_cache = AsyncMock()
        mock_order_cache.get_recent_by_phone = AsyncMock(return_value=None)

        with patch("app.sync.repositories.CustomerCache", return_value=mock_customer_cache), \
             patch("app.sync.repositories.OrderCache", return_value=mock_order_cache):
            await engine.prefetch_on_call_setup(session)

        assert session.last_order_number == ""

    async def test_order_cache_error_no_crash(self):
        engine = RealtimePipelineEngine(settings=_make_settings())
        session = _make_session()

        mock_customer_cache = AsyncMock()
        mock_customer_cache.get_by_phone = AsyncMock(return_value=None)
        mock_order_cache = AsyncMock()
        mock_order_cache.get_recent_by_phone = AsyncMock(
            side_effect=RuntimeError("timeout")
        )

        with patch("app.sync.repositories.CustomerCache", return_value=mock_customer_cache), \
             patch("app.sync.repositories.OrderCache", return_value=mock_order_cache):
            await engine.prefetch_on_call_setup(session)

        assert session.last_order_number == ""


# ── Both caches run in parallel ───────────────────────────────────────────────

class TestPrefetchParallel:
    async def test_both_caches_queried(self):
        engine = RealtimePipelineEngine(settings=_make_settings())
        session = _make_session()

        mock_customer_cache = AsyncMock()
        mock_customer_cache.get_by_phone = AsyncMock(return_value=_make_customer())
        mock_order_cache = AsyncMock()
        mock_order_cache.get_recent_by_phone = AsyncMock(return_value=_make_order())

        with patch("app.sync.repositories.CustomerCache", return_value=mock_customer_cache), \
             patch("app.sync.repositories.OrderCache", return_value=mock_order_cache):
            await engine.prefetch_on_call_setup(session)

        mock_customer_cache.get_by_phone.assert_called_once()
        mock_order_cache.get_recent_by_phone.assert_called_once()

    async def test_no_live_shopify_call_made(self):
        """prefetch_on_call_setup must only read from local cache, never call Shopify."""
        engine = RealtimePipelineEngine(settings=_make_settings())
        session = _make_session()

        mock_customer_cache = AsyncMock()
        mock_customer_cache.get_by_phone = AsyncMock(return_value=None)
        mock_order_cache = AsyncMock()
        mock_order_cache.get_recent_by_phone = AsyncMock(return_value=None)

        with patch("app.sync.repositories.CustomerCache", return_value=mock_customer_cache), \
             patch("app.sync.repositories.OrderCache", return_value=mock_order_cache), \
             patch("app.shopify.client.ShopifyGraphQLClient") as mock_shopify:
            await engine.prefetch_on_call_setup(session)

        # Shopify client must NEVER be instantiated during call setup
        mock_shopify.assert_not_called()
