"""
Step 4 enterprise test suite — production defaults, fallback, security, reliability.
"""
from __future__ import annotations

import asyncio
import json
import os
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.agent_runtime.live_runtime import resolve_live_turn_handler
from app.agent_runtime.llm_tool_runtime import RUNTIME_MODE as LLM_MODE
from app.config import Settings, get_settings
from app.memory.memory_manager import MemoryManager
from app.orchestrator.runtime import RUNTIME_MODE as ORCH_MODE, get_orchestrator_runtime
from app.payment.safety import assert_payment_link_allowed
from app.reliability.shopify_circuit_breaker import circuit_open_error, is_circuit_open, reset_circuit_for_tests
from app.security.ws_token import mint_ws_token, validate_ws_token
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    base = dict(
        session_id="ent1",
        call_sid="CA_ENT001",
        from_number="+15551235001",
        to_number="+15559995001",
    )
    base.update(kwargs)
    return SessionState(**base)


class TestOrchestratorDefaultEnabled:
    def test_orchestrator_default_enabled(self):
        s = Settings()
        assert s.VOICE_ORCHESTRATOR_ENABLED is True
        assert resolve_live_turn_handler(s) == ORCH_MODE

    def test_health_reports_orchestrator_enabled(self):
        from app.main import create_app

        client = TestClient(create_app())
        data = client.get("/health").json()
        assert data.get("orchestrator_enabled") is True


class TestLegacyFallback:
    @pytest.mark.asyncio
    async def test_fallback_only_when_explicitly_enabled(self):
        from app.ws.turn_dispatch import dispatch_turn

        settings = Settings(
            VOICE_ORCHESTRATOR_ENABLED=True,
            VOICE_LEGACY_RUNTIME_FALLBACK_ENABLED=True,
        )
        session = _session()
        fallback_used = {"value": False}

        class _FailingOrch:
            async def handle_turn(self, *a, **kw):
                raise RuntimeError("orchestrator crash")

        class _Legacy:
            async def handle_turn(self, *a, **kw):
                fallback_used["value"] = True

                class _R:
                    response_text = "legacy ok"
                return _R()

        with patch("app.orchestrator.runtime.get_orchestrator_runtime", return_value=_FailingOrch()):
            with patch("app.agent_runtime.llm_tool_runtime.get_llm_tool_runtime", return_value=_Legacy()):
                await dispatch_turn(settings, session, "hi", AsyncMock(), None)
        assert fallback_used["value"] is True

    @pytest.mark.asyncio
    async def test_no_fallback_when_disabled(self):
        from app.ws.turn_dispatch import dispatch_turn

        settings = Settings(
            VOICE_ORCHESTRATOR_ENABLED=True,
            VOICE_LEGACY_RUNTIME_FALLBACK_ENABLED=False,
        )

        class _FailingOrch:
            async def handle_turn(self, *a, **kw):
                raise RuntimeError("orchestrator crash")

        with patch("app.orchestrator.runtime.get_orchestrator_runtime", return_value=_FailingOrch()):
            with pytest.raises(RuntimeError, match="orchestrator crash"):
                await dispatch_turn(settings, _session(), "hi", AsyncMock(), None)

    def test_legacy_mode_when_orchestrator_disabled(self):
        s = Settings(VOICE_ORCHESTRATOR_ENABLED=False)
        assert resolve_live_turn_handler(s) == LLM_MODE


class TestPaymentStillBlocked:
    def test_payment_blocked_without_confirmed_email(self):
        session = _session(
            payment_cart_confirmed=True,
            cart_items=[{"variant_id": "v1", "quantity": 1}],
            payment_email_confirmed=False,
        )
        result = assert_payment_link_allowed(session)
        assert not result.allowed

    def test_payment_blocked_without_confirmed_cart(self):
        session = _session(
            payment_cart_confirmed=False,
            payment_email_confirmed=True,
            email_verified=True,
            confirmed_email="a@b.com",
        )
        from app.agent_runtime import tool_runtime_gates

        with patch.object(tool_runtime_gates, "_cart_has_confirmed_items", return_value=True):
            gate = tool_runtime_gates.gate_tool_call("send_payment_link", session)
        assert gate is not None
        assert not gate.allowed


class TestOrderPrivacyEnforced:
    @pytest.mark.asyncio
    async def test_orchestrator_blocks_unverified_order_detail(self):
        runtime = get_orchestrator_runtime(Settings(OPENAI_API_KEY=""))
        sent = []

        async def send(msg):
            sent.append(msg)

        result = await runtime.handle_turn(
            _session(), "What books are in order 9999?", send,
        )
        assert "verify" in result.response_text.lower() or "email" in result.response_text.lower() or "security" in result.response_text.lower()


class TestRedisProductionRequired:
    def test_redis_production_still_required(self):
        s = Settings(APP_ENV="production", REDIS_URL="", DEBUG=False)
        with pytest.raises(RuntimeError, match="REDIS_URL"):
            s.validate_production()


class TestWsTokenAuth:
    def test_ws_token_auth_still_required(self):
        with patch.dict(os.environ, {"TWILIO_AUTH_TOKEN": "secret-ws-key"}, clear=False):
            get_settings.cache_clear()
            token = mint_ws_token(call_sid="CAENT2", from_number="+15551112222", ttl_sec=120)
            assert validate_ws_token(token) is not None
            get_settings.cache_clear()


class TestRateLimitActive:
    @pytest.mark.asyncio
    async def test_rate_limit_still_active(self):
        from app.security.rate_limit import check_rate_limit

        key = "test_rate_ent_1"
        for _ in range(5):
            await check_rate_limit(key, limit=5, window_sec=60)
        allowed = await check_rate_limit(key, limit=5, window_sec=60)
        assert allowed is False


class TestOpenAIFallbackModel:
    def test_openai_fallback_model_works(self):
        from app.orchestrator.model_router import select_model

        s = Settings(OPENAI_FALLBACK_MODEL="fallback-mini", OPENAI_FAST_MODEL="fast-mini")
        model = select_model("composer", None, settings=s, use_fallback=True)
        assert model == "fallback-mini"


class TestShopifyCircuitBreaker:
    def test_shopify_circuit_breaker_works(self):
        reset_circuit_for_tests()
        from app.reliability import shopify_circuit_breaker as cb

        for _ in range(5):
            cb._record_failure()
        assert is_circuit_open()
        err = circuit_open_error()
        assert err["errors"][0]["extensions"]["code"] == "SHOPIFY_CIRCUIT_OPEN"
        reset_circuit_for_tests()


class TestMemorySurvivesMultiTurn:
    @pytest.mark.asyncio
    async def test_memory_survives_multi_turn_call(self):
        session = _session()
        runtime = get_orchestrator_runtime(Settings(OPENAI_API_KEY=""))

        async def send(msg):
            pass

        await runtime.handle_turn(session, "Hello", send)
        await runtime.handle_turn(session, "Looking for Dune", send)
        snap = MemoryManager.load(session)
        assert snap.turn_count >= 2
        assert snap.safe_summary


class TestOtelDisabledByDefault:
    def test_otel_disabled_by_default(self):
        s = Settings()
        assert s.OTEL_ENABLED is False
        assert s.OTEL_EXPORTER_OTLP_ENDPOINT == ""

    def test_otel_span_noop_when_disabled(self):
        from app.observability.otel import reset_otel_for_tests, span

        reset_otel_for_tests()
        with span("test_span") as s:
            assert s is None
        reset_otel_for_tests()
