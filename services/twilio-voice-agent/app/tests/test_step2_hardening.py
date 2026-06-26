"""
Step 2 hardening tests — payment safety, email FSM, Redis config, security, reliability.
"""
from __future__ import annotations

import json
import os
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.payment.email_state import (
    confirm_payment_email,
    reject_pending_payment_email,
    set_pending_payment_email,
)
from app.payment.payment_idempotency import (
    check_idempotency,
    clear_idempotency_store,
    create_idempotency_record,
    mark_emailed,
)
from app.payment.payment_state_machine import capture_payment_email, extract_email_from_text
from app.payment.safety import (
    assert_payment_link_allowed,
    validate_tool_email_arg,
)
from app.reliability.openai_retry import call_with_retry
from app.reliability.shopify_circuit_breaker import circuit_open_error, is_circuit_open, reset_circuit_for_tests
from app.security.ws_token import mint_ws_token, validate_ws_token
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    base = dict(
        session_id="sess1",
        call_sid="CA1234567890",
        from_number="+15551234567",
        to_number="+15559876543",
    )
    base.update(kwargs)
    return SessionState(**base)


class TestOrderPrivacy:
    @pytest.mark.asyncio
    async def test_unverified_lookup_omits_sensitive_fields(self):
        mock_order = {
            "data": {
                "orders": {
                    "edges": [{
                        "node": {
                            "name": "#1001",
                            "displayFinancialStatus": "PAID",
                            "displayFulfillmentStatus": "FULFILLED",
                            "lineItems": {"edges": [{"node": {"title": "Secret Book", "quantity": 1}}]},
                            "totalPriceSet": {"shopMoney": {"amount": "29.99"}},
                        },
                    }],
                },
            },
        }
        with patch("app.tools.shopify_tools.get_shopify_client") as mock_get:
            client = AsyncMock()
            client.configured = True
            client.execute = AsyncMock(return_value=mock_order)
            mock_get.return_value = client
            from app.tools.shopify_tools import lookup_order

            result = await lookup_order(order_number="1001")
        data = json.loads(result)
        assert data["found"] is True
        for field in (
            "items", "book_titles", "subtotal", "shipping", "total",
            "tracking_number", "shipping_address", "refund",
        ):
            assert field not in data


class TestPaymentSafety:
    def test_blocks_empty_cart(self):
        session = _session(payment_cart_confirmed=True, payment_email_confirmed=True, email_verified=True)
        result = assert_payment_link_allowed(session)
        assert not result.allowed
        assert result.reason in ("no_items", "no_checkout_url")

    def test_blocks_unconfirmed_cart(self):
        session = _session(
            payment_cart_confirmed=False,
            payment_email_confirmed=True,
            email_verified=True,
        )
        from app.agent_runtime import tool_runtime_gates

        with patch.object(tool_runtime_gates, "_cart_has_confirmed_items", return_value=True):
            gate = tool_runtime_gates.gate_tool_call("create_checkout", session)
        assert gate is not None
        assert gate.reason == "cart_unconfirmed"

    def test_blocks_llm_email_mismatch(self):
        session = _session(
            confirmed_email="john@gmail.com",
            payment_email_confirmed=True,
            email_verified=True,
        )
        result = validate_tool_email_arg("other@gmail.com", session)
        assert not result.allowed
        assert result.reason == "email_mismatch"

    def test_blocks_before_email_confirmation(self):
        session = _session(
            pending_payment_email="john@gmail.com",
            awaiting_payment_email_confirmation=True,
            payment_cart_confirmed=True,
            cart_items=[{"variant_id": "v1", "quantity": 1}],
        )
        result = validate_tool_email_arg(None, session)
        assert not result.allowed

    def test_blocks_without_checkout_url(self):
        session = _session(
            payment_cart_confirmed=True,
            payment_email_confirmed=True,
            email_verified=True,
            confirmed_email="john@gmail.com",
        )
        with patch("app.payment.safety.require_confirmed_cart") as mock_cart:
            from app.payment.safety import PaymentSafetyResult

            mock_cart.return_value = PaymentSafetyResult(allowed=True, reason="cart_ok", safe_message="")
            result = assert_payment_link_allowed(session)
        assert not result.allowed
        assert result.reason == "no_checkout_url"

    def test_blocks_duplicate_payment_send(self):
        clear_idempotency_store()
        key = "dup-key"
        create_idempotency_record(key, call_sid="CA1", confirmed_email="a@b.com", items=[{"variant_id": "v1", "quantity": 1}])
        mark_emailed(key)
        blocked = check_idempotency(key)
        assert not blocked.allowed
        assert blocked.action == "block_emailed"


class TestEmailFSM:
    def test_spoken_email_normalized(self):
        email = extract_email_from_text("john dot smith at gmail dot com")
        assert email == "john.smith@gmail.com"

    def test_capture_sets_confirmation_prompt(self):
        session = _session()
        hint = capture_payment_email(session, "john.smith@gmail.com")
        assert hint.force_reply
        assert "john.smith" in hint.force_reply
        assert "gmail" in hint.force_reply
        assert "correct" in hint.force_reply.lower()
        assert session.awaiting_payment_email_confirmation

    def test_confirm_sets_verified_email(self):
        session = _session()
        set_pending_payment_email(session, "john@gmail.com")
        assert confirm_payment_email(session)
        assert session.confirmed_email == "john@gmail.com"
        assert session.email_verified is True

    def test_reject_restores_backup_confirmed_email(self):
        session = _session(confirmed_email="keep@me.com", payment_email_confirmed=True, email_verified=True)
        set_pending_payment_email(session, "new@me.com")
        reject_pending_payment_email(session)
        assert session.confirmed_email == "keep@me.com"
        assert session.email_verified is True

    def test_new_email_after_confirmation_requires_reconfirm(self):
        session = _session(confirmed_email="old@me.com", payment_email_confirmed=True, email_verified=True)
        set_pending_payment_email(session, "new@me.com")
        assert session.email_verified is False
        assert session.payment_email_confirmed is False


class TestRedisProductionConfig:
    def test_production_requires_redis_url(self):
        s = Settings(APP_ENV="production", REDIS_URL="", DEBUG=False)
        with pytest.raises(RuntimeError, match="REDIS_URL"):
            s.validate_production()

    def test_development_allows_memory_fallback(self):
        s = Settings(APP_ENV="development", REDIS_URL="")
        assert s.allow_memory_store_fallback is True

    def test_production_disallows_memory_fallback(self):
        s = Settings(APP_ENV="production", REDIS_URL="redis://localhost")
        assert s.allow_memory_store_fallback is False


class TestSecurity:
    def test_ws_token_round_trip(self):
        with patch.dict(os.environ, {"TWILIO_AUTH_TOKEN": "secret-ws-key", "INTERNAL_ADMIN_KEY": ""}, clear=False):
            get_settings.cache_clear()
            token = mint_ws_token(call_sid="CAWS1", from_number="+15551112222", ttl_sec=120)
            payload = validate_ws_token(token)
            assert payload is not None
            assert payload["callSid"] == "CAWS1"
            get_settings.cache_clear()

    def test_expired_ws_token_rejected(self):
        with patch.dict(os.environ, {"TWILIO_AUTH_TOKEN": "secret-ws-key"}, clear=False):
            get_settings.cache_clear()
            with patch("app.security.ws_token.time.time", return_value=1_000_000):
                token = mint_ws_token(call_sid="CAWS2", from_number="+15553334444", ttl_sec=30)
            with patch("app.security.ws_token.time.time", return_value=1_000_100):
                assert validate_ws_token(token) is None
            get_settings.cache_clear()

    def test_production_disables_api_docs_by_default(self):
        s = Settings(APP_ENV="production", ENABLE_API_DOCS=True, DEBUG=False)
        assert s.api_docs_enabled is False

    def test_health_does_not_expose_secrets(self):
        from app.main import create_app

        client = TestClient(create_app())
        data = client.get("/health").json()
        body = json.dumps(data)
        for secret_key in ("OPENAI_API_KEY", "TWILIO_AUTH_TOKEN", "SHOPIFY_ADMIN", "RESEND_API_KEY"):
            assert secret_key not in body


class TestReliability:
    @pytest.mark.asyncio
    async def test_openai_retry_on_transient_error(self):
        calls = 0

        async def flaky():
            nonlocal calls
            calls += 1
            if calls == 1:
                raise TimeoutError("timeout")
            return "ok"

        result = await call_with_retry(flaky, max_attempts=2)
        assert result == "ok"
        assert calls == 2

    @pytest.mark.asyncio
    async def test_openai_no_retry_on_invalid_request(self):
        calls = 0

        async def invalid():
            nonlocal calls
            calls += 1
            exc = Exception("bad request")
            exc.status_code = 400
            raise exc

        with pytest.raises(Exception):
            await call_with_retry(invalid, max_attempts=2)
        assert calls == 1

    def test_shopify_circuit_open_returns_safe_error(self):
        reset_circuit_for_tests()
        from app.reliability import shopify_circuit_breaker as cb

        for _ in range(5):
            cb._record_failure()
        assert is_circuit_open()
        err = circuit_open_error()
        assert err["errors"][0]["extensions"]["code"] == "SHOPIFY_CIRCUIT_OPEN"
        reset_circuit_for_tests()

    @pytest.mark.asyncio
    async def test_shopify_client_returns_circuit_error_when_open(self):
        reset_circuit_for_tests()
        from app.reliability import shopify_circuit_breaker as cb

        for _ in range(5):
            cb._record_failure()
        from app.shopify.client import ShopifyGraphQLClient

        client = ShopifyGraphQLClient()
        result = await client.execute("query { shop { name } }")
        assert result.get("errors")
        reset_circuit_for_tests()
