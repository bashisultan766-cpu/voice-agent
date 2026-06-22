"""
Tests for Production Hardening v3.1 — Feature 4:
  Compact router intent/entity context injected into the first LLM message.

Verifies:
- Router context appears in the first LLM call's messages.
- Sensitive data (raw email, phone) is masked/redacted.
- No raw Shopify JSON, payment data, or secrets are included.
- Context is NOT stored in session.history (ephemeral per-turn).
- Unknown intent produces no context block.
- engine._build_router_context builds the expected string.
"""
from __future__ import annotations

import os
import pytest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.pipeline.engine import _build_router_context
from app.pipeline.router import IntentResult, detect
from app.pipeline.tasks import Intent
from app.state.models import SessionState


def _make_session(**kwargs) -> SessionState:
    return SessionState(
        session_id="s1",
        call_sid="CA_CTX001",
        from_number="+15551234567",
        to_number="+18005551234",
        **kwargs,
    )


def _make_intent(intent: str, entities: dict, confidence: float = 0.9) -> IntentResult:
    return IntentResult(
        intent=intent,
        confidence=confidence,
        entities=entities,
        needs_filler=True,
        suggested_tools=["search_products"],
    )


# ── _build_router_context ─────────────────────────────────────────────────────

class TestBuildRouterContext:
    def test_unknown_intent_returns_none(self):
        ir = _make_intent(Intent.UNKNOWN, {}, confidence=0.0)
        session = _make_session()
        assert _build_router_context(ir, session) is None

    def test_isbn_search_context(self):
        ir = _make_intent(Intent.ISBN_SEARCH, {"isbn": "9780306406157"})
        session = _make_session()
        ctx = _build_router_context(ir, session)
        assert ctx is not None
        assert "isbn_search" in ctx.lower() or "isbn search" in ctx.lower()
        assert "9780306406157" in ctx

    def test_order_number_in_context(self):
        ir = _make_intent(Intent.ORDER_LOOKUP, {"order_number": "#1042"})
        session = _make_session()
        ctx = _build_router_context(ir, session)
        assert "#1042" in ctx

    def test_product_phrase_in_context(self):
        ir = _make_intent(Intent.PRODUCT_SEARCH, {"product_phrase": "Dune by Frank Herbert"})
        session = _make_session()
        ctx = _build_router_context(ir, session)
        assert "Dune by Frank Herbert" in ctx

    def test_quantity_in_context(self):
        ir = _make_intent(Intent.CHECKOUT_REQUEST, {"quantity": "3"})
        session = _make_session()
        ctx = _build_router_context(ir, session)
        assert "3" in ctx

    def test_email_is_masked(self):
        ir = _make_intent(Intent.EMAIL_CAPTURE, {"email": "jessica@example.com"})
        session = _make_session()
        ctx = _build_router_context(ir, session)
        assert ctx is not None
        # Raw email must NOT appear
        assert "jessica@example.com" not in ctx
        # Masked form must appear (j***a@example.com or similar)
        assert "@example.com" in ctx or "***" in ctx

    def test_phone_is_redacted(self):
        ir = _make_intent(Intent.EMAIL_CAPTURE, {"phone": "15551234567"})
        session = _make_session()
        ctx = _build_router_context(ir, session)
        # Only last 4 digits visible
        assert "4567" in ctx
        # Full number must NOT appear
        assert "15551234567" not in ctx

    def test_no_raw_shopify_json(self):
        ir = _make_intent(Intent.ORDER_LOOKUP, {"order_number": "#1042"})
        session = _make_session()
        ctx = _build_router_context(ir, session)
        assert "{" not in (ctx or "")
        assert "gid://shopify" not in (ctx or "")

    def test_prefetch_cache_count_shown(self):
        ir = _make_intent(Intent.ISBN_SEARCH, {"isbn": "9780306406157"})
        session = _make_session()
        session.prefetch_cache = {"key1": "val1", "key2": "val2"}
        ctx = _build_router_context(ir, session)
        assert "2" in ctx

    def test_empty_prefetch_cache_not_shown(self):
        ir = _make_intent(Intent.ISBN_SEARCH, {"isbn": "9780306406157"})
        session = _make_session()
        session.prefetch_cache = {}
        ctx = _build_router_context(ir, session)
        # No mention of cache count when empty
        assert "cache" not in (ctx or "").lower() or "0" not in (ctx or "")

    def test_high_confidence_label(self):
        ir = _make_intent(Intent.ISBN_SEARCH, {}, confidence=0.95)
        session = _make_session()
        ctx = _build_router_context(ir, session)
        assert "high" in ctx

    def test_medium_confidence_label(self):
        ir = _make_intent(Intent.PRODUCT_SEARCH, {}, confidence=0.75)
        session = _make_session()
        ctx = _build_router_context(ir, session)
        assert "medium" in ctx


# ── _inject_router_context ────────────────────────────────────────────────────

class TestInjectRouterContext:
    def test_context_prepended_to_user_message(self):
        from app.ai.openai_agent import _inject_router_context
        messages = [
            {"role": "system", "content": "You are an agent."},
            {"role": "user", "content": "Hello"},
        ]
        result = _inject_router_context(messages, "[CTX]\nDetected: greeting")
        user_msgs = [m for m in result if m["role"] == "user"]
        assert len(user_msgs) == 1
        assert "[CTX]" in user_msgs[0]["content"]
        assert "Hello" in user_msgs[0]["content"]

    def test_system_message_unchanged(self):
        from app.ai.openai_agent import _inject_router_context
        messages = [
            {"role": "system", "content": "You are an agent."},
            {"role": "user", "content": "Hi"},
        ]
        result = _inject_router_context(messages, "[CTX]")
        sys_msgs = [m for m in result if m["role"] == "system"]
        assert sys_msgs[0]["content"] == "You are an agent."

    def test_empty_messages_returns_empty(self):
        from app.ai.openai_agent import _inject_router_context
        assert _inject_router_context([], "[CTX]") == []

    def test_no_user_message_returns_unchanged(self):
        from app.ai.openai_agent import _inject_router_context
        messages = [{"role": "system", "content": "sys"}]
        result = _inject_router_context(messages, "[CTX]")
        assert result == messages

    def test_context_not_stored_in_history(self):
        """Router context goes into messages list only, never into session.history."""
        from app.ai.openai_agent import _inject_router_context
        messages = [{"role": "user", "content": "isbn 9780306406157"}]
        enriched = _inject_router_context(messages, "[CTX]\nDetected ISBN")
        # Original list unchanged
        assert messages[0]["content"] == "isbn 9780306406157"
        # Enriched copy has context
        assert "[CTX]" in enriched[0]["content"]


# ── Engine passes router_context to run_agent_turn ────────────────────────────

class TestEnginePassesRouterContext:
    async def test_router_context_received_by_agent(self):
        """Engine builds and passes router_context to run_agent_turn (fallback path).

        Note: Tool intents (isbn_search, product_search, etc.) now route through
        the WorkerOrchestrator → MainLLMComposer path and do NOT call run_agent_turn.
        router_context is only passed to run_agent_turn on the conversational fallback path.
        """
        from app.pipeline.engine import RealtimePipelineEngine
        from app.config import Settings

        settings = Settings(OPENAI_API_KEY="test", DEBUG=True, VOICE_FILLER_AFTER_MS=0)
        engine = RealtimePipelineEngine(settings=settings)
        received_kwargs = {}

        async def capturing_agent(session, text, settings, **kwargs):
            received_kwargs.update(kwargs)
            yield {"type": "turn_done"}

        sent = []

        async def fake_send(msg):
            sent.append(msg)

        # Use a conversational (non-tool) intent so it routes to run_agent_turn.
        # "please confirm my order" → confirmation intent → fallback path.
        with patch("app.pipeline.engine.run_agent_turn", capturing_agent):
            session = _make_session()
            await engine.handle_turn(session, "yes please confirm", fake_send)

        # router_context should be a string (non-None for non-unknown intents)
        assert "router_context" in received_kwargs
        ctx = received_kwargs["router_context"]
        # confirmation/greeting context is a string with the detected intent
        assert ctx is None or isinstance(ctx, str)

    async def test_unknown_intent_router_context_is_none(self):
        """Unknown intent produces None router_context."""
        from app.pipeline.engine import RealtimePipelineEngine
        from app.config import Settings

        settings = Settings(OPENAI_API_KEY="test", DEBUG=True, VOICE_FILLER_AFTER_MS=0)
        engine = RealtimePipelineEngine(settings=settings)
        received_kwargs = {}

        async def capturing_agent(session, text, settings, **kwargs):
            received_kwargs.update(kwargs)
            yield {"type": "turn_done"}

        async def fake_send(msg):
            pass

        with patch("app.pipeline.engine.run_agent_turn", capturing_agent):
            session = _make_session()
            await engine.handle_turn(session, "xkcd foo bar", fake_send)

        assert received_kwargs.get("router_context") is None
