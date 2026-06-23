"""
Tests for app/pipeline/engine.py — RealtimePipelineEngine.

Covers: handle_turn, filler suppression, speculative prefetch, latency
tracking, cancellation, and call-setup prefetch.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.pipeline.engine import RealtimePipelineEngine, get_engine, _build_speculative_calls
from app.pipeline.router import IntentResult
from app.pipeline.tasks import Intent
from app.state.models import SessionState, SafeCallerContext
from app.workers.base import WorkerBundle, WorkerResult


def _empty_bundle() -> WorkerBundle:
    return WorkerBundle()


def _make_session(**kwargs) -> SessionState:
    return SessionState(
        session_id="sess-eng",
        call_sid="CA_ENG001",
        from_number="+15551234567",
        to_number="+18005551234",
        **kwargs,
    )


def _fake_settings(**overrides):
    from app.config import Settings
    defaults = dict(
        OPENAI_API_KEY="test",
        DEBUG=True,
        VOICE_TOOL_TIMEOUT_MS=2500,
        # 0 = send filler immediately (deterministic in tests).
        # In production, VOICE_FILLER_AFTER_MS=250 waits for prefetch.
        VOICE_FILLER_AFTER_MS=0,
    )
    defaults.update(overrides)
    return Settings(**defaults)


async def _run_turn_capture(engine, session, text, caller_context=None):
    """Run a turn and collect all sent messages."""
    sent = []

    async def fake_send(msg):
        sent.append(msg)

    await engine.handle_turn(session, text, fake_send, caller_context=caller_context)
    return sent


# ── Handle turn basic flow ────────────────────────────────────────────────────

class TestHandleTurnBasic:
    async def test_emits_text_tokens_and_turn_done(self):
        # v4.2: ALL intents use worker→composer path (including greeting "hi")
        engine = RealtimePipelineEngine(settings=_fake_settings())

        async def fake_stream(sess, text, ir, wb, ctx, settings=None):
            yield {"type": "text_token", "token": "Hello"}
            yield {"type": "text_token", "token": " there"}
            yield {"type": "turn_done"}

        with patch.object(engine._orchestrator, "run", AsyncMock(return_value=_empty_bundle())), \
             patch.object(engine._composer, "stream_response", fake_stream):
            session = _make_session()
            sent = await _run_turn_capture(engine, session, "hi")

        text_msgs = [m for m in sent if m.get("token") and m["token"]]
        last_msgs = [m for m in sent if m.get("last") is True]
        assert any("Hello" in m.get("token", "") for m in text_msgs)
        assert len(last_msgs) >= 1

    async def test_turn_done_sends_last_true(self):
        engine = RealtimePipelineEngine(settings=_fake_settings())

        async def fake_stream(sess, text, ir, wb, ctx, settings=None):
            yield {"type": "turn_done"}

        with patch.object(engine._orchestrator, "run", AsyncMock(return_value=_empty_bundle())), \
             patch.object(engine._composer, "stream_response", fake_stream):
            session = _make_session()
            sent = await _run_turn_capture(engine, session, "ok")

        assert any(m.get("last") is True for m in sent)

    async def test_all_text_tokens_are_interruptible(self):
        engine = RealtimePipelineEngine(settings=_fake_settings())

        async def fake_stream(sess, text, ir, wb, ctx, settings=None):
            yield {"type": "text_token", "token": "Hi"}
            yield {"type": "turn_done"}

        with patch.object(engine._orchestrator, "run", AsyncMock(return_value=_empty_bundle())), \
             patch.object(engine._composer, "stream_response", fake_stream):
            session = _make_session()
            sent = await _run_turn_capture(engine, session, "hello")

        token_msgs = [m for m in sent if m.get("type") == "text" and m.get("token")]
        for msg in token_msgs:
            assert msg.get("interruptible") is True


# ── Filler suppression ────────────────────────────────────────────────────────

class TestFillerSuppression:
    async def test_engine_filler_sent_for_tool_intents(self):
        """For isbn_search intent, engine sends a filler before the LLM."""
        engine = RealtimePipelineEngine(settings=_fake_settings())

        async def fake_run_agent_turn(session, text, settings, **kwargs):
            yield {"type": "turn_done"}

        with patch("app.pipeline.engine.run_agent_turn", fake_run_agent_turn):
            # isbn number triggers isbn_search intent
            session = _make_session()
            sent = await _run_turn_capture(engine, session, "isbn 9780306406157")

        # At least one filler message before the final last=True
        filler_msgs = [
            m for m in sent
            if m.get("type") == "text" and m.get("token") and m.get("last") is False
        ]
        assert len(filler_msgs) >= 1

    async def test_agent_filler_suppressed_when_engine_already_sent(self):
        """When engine sends filler, agent's 'filler' event must be dropped."""
        engine = RealtimePipelineEngine(settings=_fake_settings())
        filler_token = "Let me check that for you."

        async def fake_run_agent_turn(session, text, settings, **kwargs):
            yield {"type": "filler", "token": filler_token}
            yield {"type": "turn_done"}

        with patch("app.pipeline.engine.run_agent_turn", fake_run_agent_turn):
            session = _make_session()
            sent = await _run_turn_capture(engine, session, "isbn 9780306406157")

        # The agent's generic filler must not appear (engine's filler replaces it)
        filler_tokens = [m.get("token") for m in sent if m.get("token") == filler_token]
        assert len(filler_tokens) == 0

    async def test_worker_path_for_unknown_intent_completes_turn(self):
        # v4.2: unknown intent uses worker→composer path (no run_agent_turn)
        engine = RealtimePipelineEngine(settings=_fake_settings())

        async def fake_stream(sess, text, ir, wb, ctx, settings=None):
            yield {"type": "text_token", "token": "I can help with that."}
            yield {"type": "turn_done"}

        with patch.object(engine._orchestrator, "run", AsyncMock(return_value=_empty_bundle())), \
             patch.object(engine._composer, "stream_response", fake_stream):
            session = _make_session()
            sent = await _run_turn_capture(engine, session, "xkcd foo bar")

        assert any(m.get("last") is True for m in sent)

    async def test_greeting_completes_turn_via_worker_path(self):
        # v4.2: greeting uses worker→composer path, not run_agent_turn
        engine = RealtimePipelineEngine(settings=_fake_settings())

        async def fake_stream(sess, text, ir, wb, ctx, settings=None):
            yield {"type": "text_token", "token": "Hello!"}
            yield {"type": "turn_done"}

        with patch.object(engine._orchestrator, "run", AsyncMock(return_value=_empty_bundle())), \
             patch.object(engine._composer, "stream_response", fake_stream):
            session = _make_session()
            sent = await _run_turn_capture(engine, session, "hello")

        text_first = next((m for m in sent if m.get("token")), None)
        if text_first:
            assert "Hello" in text_first["token"] or "SureShot" in text_first["token"]


# ── Error handling ────────────────────────────────────────────────────────────

class TestErrorHandling:
    async def test_composer_exception_sends_error_message(self):
        engine = RealtimePipelineEngine(settings=_fake_settings())

        async def bad_stream(sess, text, ir, wb, ctx, settings=None):
            raise RuntimeError("OpenAI error")
            yield  # make it a generator

        with patch.object(engine._orchestrator, "run", AsyncMock(return_value=_empty_bundle())), \
             patch.object(engine._composer, "stream_response", bad_stream), \
             patch("app.agent_runtime.final_response_composer._deterministic_response", return_value=None):
            session = _make_session()
            sent = await _run_turn_capture(engine, session, "search for Dune by Frank Herbert")

        assert any(m.get("last") is True for m in sent)
        assert any(m.get("token") for m in sent)

    async def test_cancellation_propagates(self):
        engine = RealtimePipelineEngine(settings=_fake_settings())

        async def slow_agent(session, text, settings, **kwargs):
            await asyncio.sleep(10)
            yield {"type": "turn_done"}

        async def run():
            session = _make_session()
            sent = []

            async def fake_send(msg):
                sent.append(msg)

            task = asyncio.create_task(
                engine.handle_turn(session, "hi", fake_send)
            )
            await asyncio.sleep(0.02)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

        with patch("app.pipeline.engine.run_agent_turn", slow_agent):
            await run()  # must complete without hanging


# ── Caller context forwarding ─────────────────────────────────────────────────

class TestCallerContextForwarding:
    async def test_caller_context_passed_to_composer(self):
        # v4.2: caller_context is forwarded to the composer (worker path)
        engine = RealtimePipelineEngine(settings=_fake_settings())
        received_ctx = []

        async def capturing_stream(sess, text, ir, wb, ctx, settings=None):
            received_ctx.append(ctx)
            yield {"type": "turn_done"}

        ctx = SafeCallerContext(is_returning_caller=True, caller_name="Alice")

        with patch.object(engine._orchestrator, "run", AsyncMock(return_value=_empty_bundle())), \
             patch.object(engine._composer, "stream_response", capturing_stream), \
             patch("app.agent_runtime.final_response_composer._deterministic_response", return_value=None):
            session = _make_session()
            await _run_turn_capture(engine, session, "isbn 9780441172719", caller_context=ctx)

        assert received_ctx[0] is ctx


# ── Speculative call builder ──────────────────────────────────────────────────

class TestBuildSpeculativeCalls:
    def _make_intent(self, intent, entities=None, confidence=0.9):
        return IntentResult(
            intent=intent,
            confidence=confidence,
            entities=entities or {},
            needs_filler=True,
            suggested_tools=[],
        )

    def test_isbn_search_builds_search_call(self):
        ir = self._make_intent(Intent.ISBN_SEARCH, {"isbn": "9780306406157"})
        session = _make_session()
        calls = _build_speculative_calls(ir, session)
        assert len(calls) == 1
        assert calls[0]["name"] == "search_products"
        assert calls[0]["args"]["query"] == "9780306406157"

    def test_product_search_uses_phrase(self):
        ir = self._make_intent(Intent.PRODUCT_SEARCH, {"product_phrase": "Dune"})
        session = _make_session()
        calls = _build_speculative_calls(ir, session)
        assert len(calls) == 1
        assert calls[0]["args"]["query"] == "Dune"

    def test_order_lookup_requires_order_number(self):
        ir = self._make_intent(Intent.ORDER_LOOKUP, {})
        session = _make_session()
        calls = _build_speculative_calls(ir, session)
        assert calls == []  # no order_number — nothing to prefetch

    def test_order_lookup_with_number_builds_call(self):
        ir = self._make_intent(Intent.ORDER_LOOKUP, {"order_number": "#1042"})
        session = _make_session()
        calls = _build_speculative_calls(ir, session)
        assert len(calls) == 1
        assert calls[0]["name"] == "lookup_order"

    def test_refund_status_requires_both(self):
        # Only order number — no email → no prefetch
        ir = self._make_intent(Intent.REFUND_STATUS, {"order_number": "#1042"})
        session = _make_session()
        calls = _build_speculative_calls(ir, session)
        assert calls == []

    def test_refund_status_with_email_builds_call(self):
        ir = self._make_intent(
            Intent.REFUND_STATUS,
            {"order_number": "#1042", "email": "test@test.com"},
        )
        session = _make_session()
        calls = _build_speculative_calls(ir, session)
        assert len(calls) == 1
        assert calls[0]["name"] == "get_refund_status"

    def test_unknown_intent_no_calls(self):
        ir = self._make_intent(Intent.UNKNOWN, {}, confidence=0.0)
        session = _make_session()
        calls = _build_speculative_calls(ir, session)
        assert calls == []


# ── get_engine singleton ──────────────────────────────────────────────────────

class TestGetEngine:
    def test_get_engine_returns_instance(self):
        e = get_engine()
        assert isinstance(e, RealtimePipelineEngine)

    def test_get_engine_singleton(self):
        e1 = get_engine()
        e2 = get_engine()
        assert e1 is e2


# ── Latency tracing ───────────────────────────────────────────────────────────

class TestLatencyTracking:
    async def test_router_ms_populated(self):
        from unittest.mock import MagicMock

        engine = RealtimePipelineEngine(settings=_fake_settings())
        turn_captured = []

        class SpyTracer:
            def start_turn(self, call_sid, intent="unknown"):
                from app.pipeline.latency import TurnLatency
                t = TurnLatency(call_sid_partial=call_sid[:6])
                return t

            def mark(self, turn, checkpoint):
                pass

            def finish(self, turn):
                turn_captured.append(turn)

        engine._tracer = SpyTracer()

        async def fake_run_agent_turn(session, text, settings, **kwargs):
            yield {"type": "turn_done"}

        with patch("app.pipeline.engine.run_agent_turn", fake_run_agent_turn):
            session = _make_session()
            await _run_turn_capture(engine, session, "hello")

        assert len(turn_captured) == 1
        assert turn_captured[0].router_ms >= 0
