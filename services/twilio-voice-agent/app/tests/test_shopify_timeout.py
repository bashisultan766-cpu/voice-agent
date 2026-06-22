"""
Tests for Feature 6 — VOICE_SHOPIFY_TIMEOUT_MS takes precedence in ShopifyGraphQLClient.

Verified behavior:
- If VOICE_SHOPIFY_TIMEOUT_MS is set, _timeout = VOICE_SHOPIFY_TIMEOUT_MS / 1000.
- If VOICE_SHOPIFY_TIMEOUT_MS is 0 or unset, _timeout = SHOPIFY_TIMEOUT_SECS.
"""
from __future__ import annotations

import os
import pytest
from unittest.mock import patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")


def _make_client(voice_ms: int, shopify_secs: float = 10.0):
    """Instantiate ShopifyGraphQLClient with controlled settings values."""
    from app.config import Settings
    from app.shopify.client import ShopifyGraphQLClient

    s = Settings(
        OPENAI_API_KEY="test",
        DEBUG=True,
        VOICE_SHOPIFY_TIMEOUT_MS=voice_ms,
        SHOPIFY_TIMEOUT_SECS=shopify_secs,
    )
    with patch("app.shopify.client.get_settings", return_value=s):
        return ShopifyGraphQLClient()


class TestVoiceShopifyTimeoutPrecedence:
    def test_voice_timeout_ms_takes_precedence(self):
        """VOICE_SHOPIFY_TIMEOUT_MS=3000 → _timeout=3.0s."""
        client = _make_client(voice_ms=3000, shopify_secs=10)
        assert client._timeout == pytest.approx(3.0)

    def test_fallback_to_shopify_timeout_secs_when_voice_unset(self):
        """VOICE_SHOPIFY_TIMEOUT_MS=0 → _timeout=SHOPIFY_TIMEOUT_SECS."""
        client = _make_client(voice_ms=0, shopify_secs=7)
        assert client._timeout == pytest.approx(7.0)

    def test_voice_timeout_500ms(self):
        """VOICE_SHOPIFY_TIMEOUT_MS=500 → _timeout=0.5s."""
        client = _make_client(voice_ms=500)
        assert client._timeout == pytest.approx(0.5)

    def test_voice_timeout_2000ms(self):
        """VOICE_SHOPIFY_TIMEOUT_MS=2000 → _timeout=2.0s."""
        client = _make_client(voice_ms=2000)
        assert client._timeout == pytest.approx(2.0)

    def test_shopify_timeout_secs_used_as_fallback(self):
        """Legacy SHOPIFY_TIMEOUT_SECS is still respected when voice setting is 0."""
        client = _make_client(voice_ms=0, shopify_secs=15)
        assert client._timeout == pytest.approx(15.0)

    def test_voice_timeout_overrides_even_larger_shopify_timeout(self):
        """VOICE timeout wins even when SHOPIFY_TIMEOUT_SECS is larger."""
        client = _make_client(voice_ms=1500, shopify_secs=30)
        assert client._timeout == pytest.approx(1.5)
        assert client._timeout < 30.0
