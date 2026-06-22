"""
Tests for Production Hardening v3.1 — Feature 6:
  ProductCache lookup by title and handle.

Verifies that ProductCache.set() writes title and handle indexes, and
that get_by_title() / get_by_handle() can retrieve products from them.
"""
from __future__ import annotations

import os
import pytest
from unittest.mock import AsyncMock, call, patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.sync.repositories import ProductCache, CachedProduct, _normalize_title_key


def _make_product(**kwargs) -> CachedProduct:
    defaults = dict(
        product_id="gid://shopify/Product/1",
        title="Dune",
        handle="dune",
        isbn="9780441013593",
        author="Frank Herbert",
        variant_id="gid://shopify/ProductVariant/10",
        price="9.99",
        currency="USD",
        available=True,
    )
    defaults.update(kwargs)
    return CachedProduct(**defaults)


# ── _normalize_title_key helper ───────────────────────────────────────────────

class TestNormalizeTitleKey:
    def test_basic(self):
        assert _normalize_title_key("Dune") == "dune"

    def test_strips_punctuation(self):
        assert _normalize_title_key("The Lord of the Rings!") == "the_lord_of_the_rings"

    def test_collapses_spaces(self):
        assert _normalize_title_key("  War  and  Peace  ") == "war_and_peace"

    def test_empty_returns_empty(self):
        assert _normalize_title_key("") == ""

    def test_caps_at_100_chars(self):
        long_title = "A" * 200
        key = _normalize_title_key(long_title)
        assert len(key) <= 100

    def test_apostrophe_stripped(self):
        key = _normalize_title_key("Harry Potter's Wand")
        assert "'" not in key

    def test_unicode_lowercased(self):
        key = _normalize_title_key("Óscar's Book")
        assert key == key.lower()


# ── ProductCache.set() writes all indexes ─────────────────────────────────────

class TestProductCacheSetWritesIndexes:
    async def test_set_writes_isbn_key(self):
        written_keys = []

        async def fake_set(key, val, ttl):
            written_keys.append(key)

        with patch("app.sync.repositories.cache_set", fake_set):
            cache = ProductCache()
            await cache.set(_make_product())

        assert any("isbn:" in k for k in written_keys)

    async def test_set_writes_id_key(self):
        written_keys = []

        async def fake_set(key, val, ttl):
            written_keys.append(key)

        with patch("app.sync.repositories.cache_set", fake_set):
            cache = ProductCache()
            await cache.set(_make_product())

        assert any("sync:product:id:" in k for k in written_keys)

    async def test_set_writes_title_key(self):
        written_keys = []

        async def fake_set(key, val, ttl):
            written_keys.append(key)

        with patch("app.sync.repositories.cache_set", fake_set):
            cache = ProductCache()
            await cache.set(_make_product(title="Dune"))

        assert any("sync:product:title:dune" in k for k in written_keys)

    async def test_set_writes_handle_key(self):
        written_keys = []

        async def fake_set(key, val, ttl):
            written_keys.append(key)

        with patch("app.sync.repositories.cache_set", fake_set):
            cache = ProductCache()
            await cache.set(_make_product(handle="dune"))

        assert any("sync:product:handle:dune" in k for k in written_keys)

    async def test_set_skips_title_key_when_empty(self):
        written_keys = []

        async def fake_set(key, val, ttl):
            written_keys.append(key)

        with patch("app.sync.repositories.cache_set", fake_set):
            cache = ProductCache()
            await cache.set(_make_product(title=""))

        assert not any("sync:product:title:" in k for k in written_keys)

    async def test_set_skips_handle_key_when_empty(self):
        written_keys = []

        async def fake_set(key, val, ttl):
            written_keys.append(key)

        with patch("app.sync.repositories.cache_set", fake_set):
            cache = ProductCache()
            await cache.set(_make_product(handle=""))

        assert not any("sync:product:handle:" in k for k in written_keys)


# ── ProductCache.get_by_title() ───────────────────────────────────────────────

class TestProductCacheGetByTitle:
    async def test_hit_returns_product(self):
        product = _make_product(title="Dune")
        stored = product.to_dict()

        async def fake_get(key):
            if key == f"sync:product:title:{_normalize_title_key('Dune')}":
                return stored
            return None

        with patch("app.sync.repositories.cache_get", fake_get):
            cache = ProductCache()
            result = await cache.get_by_title("Dune")

        assert result is not None
        assert result.title == "Dune"

    async def test_miss_returns_none(self):
        async def fake_get(key):
            return None

        with patch("app.sync.repositories.cache_get", fake_get):
            cache = ProductCache()
            result = await cache.get_by_title("Unknown Book")

        assert result is None

    async def test_empty_title_returns_none(self):
        async def fake_get(key):
            return {"x": 1}

        with patch("app.sync.repositories.cache_get", fake_get):
            cache = ProductCache()
            result = await cache.get_by_title("")

        assert result is None

    async def test_title_normalized_before_lookup(self):
        """'DUNE' and 'dune' should map to the same key."""
        product = _make_product(title="Dune")
        stored = product.to_dict()
        looked_up_keys = []

        async def fake_get(key):
            looked_up_keys.append(key)
            return stored

        with patch("app.sync.repositories.cache_get", fake_get):
            cache = ProductCache()
            await cache.get_by_title("DUNE")

        assert any("dune" in k for k in looked_up_keys)


# ── ProductCache.get_by_handle() ──────────────────────────────────────────────

class TestProductCacheGetByHandle:
    async def test_hit_returns_product(self):
        product = _make_product(handle="dune")
        stored = product.to_dict()

        async def fake_get(key):
            if key == "sync:product:handle:dune":
                return stored
            return None

        with patch("app.sync.repositories.cache_get", fake_get):
            cache = ProductCache()
            result = await cache.get_by_handle("dune")

        assert result is not None
        assert result.handle == "dune"

    async def test_miss_returns_none(self):
        async def fake_get(key):
            return None

        with patch("app.sync.repositories.cache_get", fake_get):
            cache = ProductCache()
            result = await cache.get_by_handle("not-a-real-book")

        assert result is None

    async def test_empty_handle_returns_none(self):
        with patch("app.sync.repositories.cache_get", AsyncMock(return_value={"x": 1})):
            cache = ProductCache()
            result = await cache.get_by_handle("")

        assert result is None

    async def test_handle_uppercased_normalized(self):
        """'DUNE' handle should be normalized to 'dune' before lookup."""
        looked_up_keys = []

        async def fake_get(key):
            looked_up_keys.append(key)
            return None

        with patch("app.sync.repositories.cache_get", fake_get):
            cache = ProductCache()
            await cache.get_by_handle("DUNE")

        assert any("handle:dune" in k for k in looked_up_keys)


# ── Round-trip via in-memory fallback ─────────────────────────────────────────

class TestProductCacheRoundTrip:
    async def test_set_then_get_by_title(self):
        """set() followed by get_by_title() should return the same product."""
        store = {}

        async def fake_set(key, val, ttl):
            store[key] = val

        async def fake_get(key):
            return store.get(key)

        with patch("app.sync.repositories.cache_set", fake_set), \
             patch("app.sync.repositories.cache_get", fake_get):
            cache = ProductCache()
            product = _make_product(title="Foundation", handle="foundation")
            await cache.set(product)
            result = await cache.get_by_title("Foundation")

        assert result is not None
        assert result.title == "Foundation"

    async def test_set_then_get_by_handle(self):
        store = {}

        async def fake_set(key, val, ttl):
            store[key] = val

        async def fake_get(key):
            return store.get(key)

        with patch("app.sync.repositories.cache_set", fake_set), \
             patch("app.sync.repositories.cache_get", fake_get):
            cache = ProductCache()
            product = _make_product(title="Foundation", handle="foundation")
            await cache.set(product)
            result = await cache.get_by_handle("foundation")

        assert result is not None
        assert result.handle == "foundation"
