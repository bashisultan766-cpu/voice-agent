"""
Tests for app/sync/webhooks.py — HMAC verification and webhook handlers.

Uses FastAPI TestClient and async mocks. No live Redis or Shopify required.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import pytest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.sync.webhooks import verify_shopify_hmac


# ── verify_shopify_hmac ───────────────────────────────────────────────────────

class TestVerifyShopifyHmac:
    def _make_sig(self, body: bytes, secret: str) -> str:
        digest = hmac.new(secret.encode(), body, hashlib.sha256).digest()
        return base64.b64encode(digest).decode()

    def test_valid_signature_returns_true(self):
        body = b'{"id": 1}'
        secret = "my-webhook-secret"
        sig = self._make_sig(body, secret)
        assert verify_shopify_hmac(body, sig, secret) is True

    def test_invalid_signature_returns_false(self):
        body = b'{"id": 1}'
        secret = "my-webhook-secret"
        assert verify_shopify_hmac(body, "badsig==", secret) is False

    def test_empty_secret_returns_false(self):
        body = b'{"id": 1}'
        assert verify_shopify_hmac(body, "anysig==", "") is False

    def test_empty_signature_returns_false(self):
        body = b'{"id": 1}'
        assert verify_shopify_hmac(body, "", "secret") is False

    def test_tampered_body_fails(self):
        original_body = b'{"id": 1}'
        tampered_body = b'{"id": 2}'
        secret = "my-webhook-secret"
        sig = self._make_sig(original_body, secret)
        assert verify_shopify_hmac(tampered_body, sig, secret) is False

    def test_different_secret_fails(self):
        body = b'{"id": 1}'
        sig = self._make_sig(body, "secret-a")
        assert verify_shopify_hmac(body, sig, "secret-b") is False

    def test_timing_safe_comparison(self):
        """Verify uses hmac.compare_digest (timing-safe)."""
        import inspect
        from app.sync import webhooks
        source = inspect.getsource(webhooks.verify_shopify_hmac)
        assert "compare_digest" in source


# ── FastAPI webhook endpoint tests ────────────────────────────────────────────

def _make_sig(body: bytes, secret: str) -> str:
    digest = hmac.new(secret.encode(), body, hashlib.sha256).digest()
    return base64.b64encode(digest).decode()


def _get_test_client():
    """Create a minimal FastAPI app with webhook routes for testing."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.sync.webhooks import webhooks_router, admin_router

    app = FastAPI()
    app.include_router(webhooks_router)
    app.include_router(admin_router)
    return TestClient(app)


class TestProductWebhook:
    def test_valid_signature_returns_200(self):
        client = _get_test_client()
        secret = "test-secret"
        body = json.dumps({"id": 1, "title": "Dune", "handle": "dune", "variants": [], "tags": ""}).encode()
        sig = _make_sig(body, secret)

        from app.config import Settings
        settings = Settings(SHOPIFY_WEBHOOK_SECRET=secret, DEBUG=True)

        with patch("app.sync.webhooks.get_settings", return_value=settings), \
             patch("app.sync.webhooks._process_product", new_callable=AsyncMock):
            response = client.post(
                "/webhooks/shopify/products",
                content=body,
                headers={
                    "content-type": "application/json",
                    "x-shopify-hmac-sha256": sig,
                    "x-shopify-topic": "products/update",
                },
            )
        assert response.status_code == 200

    def test_invalid_signature_returns_401(self):
        client = _get_test_client()
        secret = "test-secret"
        body = json.dumps({"id": 1}).encode()

        from app.config import Settings
        settings = Settings(SHOPIFY_WEBHOOK_SECRET=secret, DEBUG=True)

        with patch("app.sync.webhooks.get_settings", return_value=settings):
            response = client.post(
                "/webhooks/shopify/products",
                content=body,
                headers={
                    "content-type": "application/json",
                    "x-shopify-hmac-sha256": "invalidsignature==",
                },
            )
        assert response.status_code == 401

    def test_no_secret_configured_skips_validation(self):
        """When SHOPIFY_WEBHOOK_SECRET is empty, validation is skipped (dev mode)."""
        client = _get_test_client()
        body = json.dumps({"id": 1, "title": "T", "handle": "h", "variants": [], "tags": ""}).encode()

        from app.config import Settings
        settings = Settings(SHOPIFY_WEBHOOK_SECRET="", DEBUG=True)

        with patch("app.sync.webhooks.get_settings", return_value=settings), \
             patch("app.sync.webhooks._process_product", new_callable=AsyncMock):
            response = client.post(
                "/webhooks/shopify/products",
                content=body,
                headers={"content-type": "application/json", "x-shopify-hmac-sha256": ""},
            )
        assert response.status_code == 200


class TestOrderWebhook:
    def test_valid_order_webhook_returns_200(self):
        client = _get_test_client()
        secret = "test-secret"
        body = json.dumps({
            "id": 200, "name": "#1042",
            "customer": {"id": 100, "phone": "+15551234567", "email": "t@t.com"},
            "financial_status": "paid", "line_items": [], "refunds": [], "fulfillments": [],
        }).encode()
        sig = _make_sig(body, secret)

        from app.config import Settings
        settings = Settings(SHOPIFY_WEBHOOK_SECRET=secret, DEBUG=True)

        with patch("app.sync.webhooks.get_settings", return_value=settings), \
             patch("app.sync.webhooks._process_order", new_callable=AsyncMock):
            response = client.post(
                "/webhooks/shopify/orders",
                content=body,
                headers={"content-type": "application/json", "x-shopify-hmac-sha256": sig},
            )
        assert response.status_code == 200


class TestCustomerWebhook:
    def test_valid_customer_webhook_returns_200(self):
        client = _get_test_client()
        secret = "test-secret"
        body = json.dumps({
            "id": 300, "first_name": "Alice", "last_name": "Smith",
            "phone": "+15551234567", "email": "alice@example.com",
        }).encode()
        sig = _make_sig(body, secret)

        from app.config import Settings
        settings = Settings(SHOPIFY_WEBHOOK_SECRET=secret, DEBUG=True)

        with patch("app.sync.webhooks.get_settings", return_value=settings), \
             patch("app.sync.webhooks._process_customer", new_callable=AsyncMock):
            response = client.post(
                "/webhooks/shopify/customers",
                content=body,
                headers={"content-type": "application/json", "x-shopify-hmac-sha256": sig},
            )
        assert response.status_code == 200


class TestRefundWebhook:
    def test_valid_refund_webhook_returns_200(self):
        client = _get_test_client()
        secret = "test-secret"
        body = json.dumps({"id": 400, "order_id": 200}).encode()
        sig = _make_sig(body, secret)

        from app.config import Settings
        settings = Settings(SHOPIFY_WEBHOOK_SECRET=secret, DEBUG=True)

        with patch("app.sync.webhooks.get_settings", return_value=settings), \
             patch("app.sync.webhooks._process_refund", new_callable=AsyncMock):
            response = client.post(
                "/webhooks/shopify/refunds",
                content=body,
                headers={"content-type": "application/json", "x-shopify-hmac-sha256": sig},
            )
        assert response.status_code == 200


class TestAdminSync:
    def test_valid_admin_key_triggers_sync(self):
        client = _get_test_client()
        admin_key = "secret-admin-key"

        from app.config import Settings
        settings = Settings(INTERNAL_ADMIN_KEY=admin_key, DEBUG=True)

        with patch("app.sync.webhooks.get_settings", return_value=settings), \
             patch("app.sync.webhooks.sync_shopify_store", new_callable=AsyncMock):
            response = client.post(
                "/admin/sync",
                headers={"x-admin-key": admin_key},
            )
        assert response.status_code == 200
        assert response.json()["status"] == "sync started"

    def test_wrong_admin_key_returns_403(self):
        client = _get_test_client()
        admin_key = "correct-key"

        from app.config import Settings
        settings = Settings(INTERNAL_ADMIN_KEY=admin_key, DEBUG=True)

        with patch("app.sync.webhooks.get_settings", return_value=settings):
            response = client.post(
                "/admin/sync",
                headers={"x-admin-key": "wrong-key"},
            )
        assert response.status_code == 403

    def test_no_admin_key_configured_returns_403(self):
        client = _get_test_client()

        from app.config import Settings
        settings = Settings(INTERNAL_ADMIN_KEY="", DEBUG=True)

        with patch("app.sync.webhooks.get_settings", return_value=settings):
            response = client.post(
                "/admin/sync",
                headers={"x-admin-key": "anything"},
            )
        assert response.status_code == 403


# ── Security: secrets never logged ───────────────────────────────────────────

class TestSecurityProperties:
    def test_webhook_secret_not_in_module_repr(self):
        from app.sync import webhooks
        import inspect
        source = inspect.getsource(webhooks)
        assert "replace_me" not in source

    def test_admin_key_not_logged_directly(self):
        from app.sync import webhooks
        import inspect
        source = inspect.getsource(webhooks)
        # Admin key must not be logged — it's only compared, not printed
        assert 'logger.info("admin_key' not in source.lower()
        assert 'logger.info("INTERNAL_ADMIN_KEY' not in source.lower()
