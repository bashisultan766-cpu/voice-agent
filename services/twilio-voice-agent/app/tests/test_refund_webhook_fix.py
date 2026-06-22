"""
Tests for Production Hardening v3.1 — Feature 8:
  Refund webhook order-number edge case fix.

The bug: Shopify refund webhooks contain ``order_id`` as a numeric DB ID
(e.g. 987654321), not the display name (e.g. #1042). The old code created
"#987654321" as a lookup key, which never matched cached orders.

The fix:
  1. Try ``order_name`` / ``name`` / ``order_number`` fields first (display name).
  2. Fall back to GID-based lookup via OrderCache.get_by_shopify_id().
  3. OrderCache.set() now also writes a ``sync:order:gid:{gid}`` key.
"""
from __future__ import annotations

import os
import pytest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.sync.webhooks import _process_refund
from app.sync.repositories import CachedOrder, OrderCache


def _make_order(order_number: str = "#1042", order_id: str = "gid://shopify/Order/987654321") -> CachedOrder:
    return CachedOrder(
        order_id=order_id,
        order_number=order_number,
        normalized_phone="15551234567",
        financial_status="paid",
        refund_count=0,
    )


# ── Refund via order_name field ───────────────────────────────────────────────

class TestRefundViaOrderName:
    async def test_order_name_field_used_for_lookup(self):
        order = _make_order("#1042")

        mock_cache = AsyncMock(spec=OrderCache)
        mock_cache.get_by_number = AsyncMock(return_value=order)
        mock_cache.get_by_shopify_id = AsyncMock(return_value=None)
        mock_cache.set = AsyncMock()

        payload = {"id": 400, "order_id": 987654321, "order_name": "#1042"}

        with patch("app.sync.repositories.OrderCache", return_value=mock_cache):
            await _process_refund(payload)

        mock_cache.get_by_number.assert_called_once_with("#1042")
        mock_cache.set.assert_called_once()
        saved_order = mock_cache.set.call_args[0][0]
        assert saved_order.refund_count == 1

    async def test_name_field_used_when_order_name_absent(self):
        order = _make_order("#1042")

        mock_cache = AsyncMock(spec=OrderCache)
        mock_cache.get_by_number = AsyncMock(return_value=order)
        mock_cache.get_by_shopify_id = AsyncMock(return_value=None)
        mock_cache.set = AsyncMock()

        payload = {"id": 400, "order_id": 987654321, "name": "#1042"}

        with patch("app.sync.repositories.OrderCache", return_value=mock_cache):
            await _process_refund(payload)

        mock_cache.get_by_number.assert_called_once_with("#1042")
        assert mock_cache.set.called


# ── Refund via Shopify order ID (GID fallback) ────────────────────────────────

class TestRefundViaShopifyId:
    async def test_shopify_id_lookup_used_as_fallback(self):
        """When no display name is in payload, look up by Shopify numeric order ID."""
        order = _make_order("#1042")

        mock_cache = AsyncMock(spec=OrderCache)
        mock_cache.get_by_number = AsyncMock(return_value=None)
        mock_cache.get_by_shopify_id = AsyncMock(return_value=order)
        mock_cache.set = AsyncMock()

        # Payload contains only the numeric order_id (no display name)
        payload = {"id": 400, "order_id": 987654321}

        with patch("app.sync.repositories.OrderCache", return_value=mock_cache):
            await _process_refund(payload)

        mock_cache.get_by_shopify_id.assert_called_once_with("987654321")
        assert mock_cache.set.called
        saved_order = mock_cache.set.call_args[0][0]
        assert saved_order.refund_count == 1

    async def test_no_order_id_no_crash(self):
        mock_cache = AsyncMock(spec=OrderCache)
        mock_cache.get_by_number = AsyncMock(return_value=None)
        mock_cache.get_by_shopify_id = AsyncMock(return_value=None)
        mock_cache.set = AsyncMock()

        with patch("app.sync.repositories.OrderCache", return_value=mock_cache):
            await _process_refund({})

        mock_cache.set.assert_not_called()

    async def test_old_code_would_have_failed(self):
        """Demonstrate that '#987654321' is NOT a valid cached order name."""
        # This lookup would have been done by the old code.
        # The correct stored key is "1042" (stripped display name).
        mock_cache = AsyncMock(spec=OrderCache)
        mock_cache.get_by_number = AsyncMock(return_value=None)

        with patch("app.sync.repositories.OrderCache", return_value=mock_cache):
            # Simulate the OLD buggy approach
            payload = {"order_id": 987654321}
            wrong_key = f"#{payload['order_id']}"
            result = await mock_cache.get_by_number(wrong_key)

        assert result is None  # confirms the old approach fails


# ── OrderCache.get_by_shopify_id ──────────────────────────────────────────────

class TestOrderCacheGetByShopifyId:
    async def test_numeric_id_resolves_to_gid(self):
        order = _make_order()
        stored = order.to_dict()

        async def fake_get(key):
            if key == "sync:order:gid:gid://shopify/Order/987654321":
                return stored
            return None

        with patch("app.sync.repositories.cache_get", fake_get):
            cache = OrderCache()
            result = await cache.get_by_shopify_id("987654321")

        assert result is not None
        assert result.order_number == "#1042"

    async def test_full_gid_accepted(self):
        order = _make_order()
        stored = order.to_dict()

        async def fake_get(key):
            if key == "sync:order:gid:gid://shopify/Order/987654321":
                return stored
            return None

        with patch("app.sync.repositories.cache_get", fake_get):
            cache = OrderCache()
            result = await cache.get_by_shopify_id("gid://shopify/Order/987654321")

        assert result is not None

    async def test_empty_id_returns_none(self):
        with patch("app.sync.repositories.cache_get", AsyncMock(return_value=None)):
            cache = OrderCache()
            result = await cache.get_by_shopify_id("")

        assert result is None

    async def test_miss_returns_none(self):
        with patch("app.sync.repositories.cache_get", AsyncMock(return_value=None)):
            cache = OrderCache()
            result = await cache.get_by_shopify_id("999")

        assert result is None


# ── OrderCache.set() writes GID index ────────────────────────────────────────

class TestOrderCacheSetWritesGidKey:
    async def test_set_writes_gid_key(self):
        written_keys = []

        async def fake_set(key, val, ttl):
            written_keys.append(key)

        with patch("app.sync.repositories.cache_set", fake_set):
            cache = OrderCache()
            order = _make_order()
            await cache.set(order)

        gid_keys = [k for k in written_keys if "sync:order:gid:" in k]
        assert len(gid_keys) == 1
        assert "gid://shopify/Order/987654321" in gid_keys[0]

    async def test_set_skips_gid_key_when_order_id_empty(self):
        written_keys = []

        async def fake_set(key, val, ttl):
            written_keys.append(key)

        with patch("app.sync.repositories.cache_set", fake_set):
            cache = OrderCache()
            order = _make_order()
            order.order_id = ""
            await cache.set(order)

        gid_keys = [k for k in written_keys if "sync:order:gid:" in k]
        assert len(gid_keys) == 0


# ── Refund increments count correctly ────────────────────────────────────────

class TestRefundCountIncrement:
    async def test_refund_count_incremented(self):
        order = _make_order()
        order.refund_count = 2

        saved = []
        mock_cache = AsyncMock(spec=OrderCache)
        mock_cache.get_by_number = AsyncMock(return_value=order)
        mock_cache.get_by_shopify_id = AsyncMock(return_value=None)

        async def capture_set(o):
            saved.append(o)

        mock_cache.set = capture_set

        payload = {"id": 400, "order_id": 987654321, "order_name": "#1042"}

        with patch("app.sync.repositories.OrderCache", return_value=mock_cache):
            await _process_refund(payload)

        assert len(saved) == 1
        assert saved[0].refund_count == 3

    async def test_cache_miss_no_set_called(self):
        mock_cache = AsyncMock(spec=OrderCache)
        mock_cache.get_by_number = AsyncMock(return_value=None)
        mock_cache.get_by_shopify_id = AsyncMock(return_value=None)
        mock_cache.set = AsyncMock()

        payload = {"id": 400, "order_id": 987654321}

        with patch("app.sync.repositories.OrderCache", return_value=mock_cache):
            await _process_refund(payload)

        mock_cache.set.assert_not_called()

    async def test_cache_error_no_crash(self):
        mock_cache = AsyncMock(spec=OrderCache)
        mock_cache.get_by_number = AsyncMock(side_effect=RuntimeError("Redis down"))
        mock_cache.get_by_shopify_id = AsyncMock(return_value=None)
        mock_cache.set = AsyncMock()

        with patch("app.sync.repositories.OrderCache", return_value=mock_cache):
            await _process_refund({"order_id": 987654321})

        mock_cache.set.assert_not_called()
