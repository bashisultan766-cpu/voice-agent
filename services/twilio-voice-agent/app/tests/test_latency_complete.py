"""
Tests for Production Hardening v3.1 — Feature 5:
  Complete latency tracing fields.

Verifies that TurnLatency has all required fields and that LatencyTracer
logs a structured line without any PII.
"""
from __future__ import annotations

import logging
import os
import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.pipeline.latency import TurnLatency, LatencyTracer, get_tracer


# ── TurnLatency dataclass ─────────────────────────────────────────────────────

class TestTurnLatencyFields:
    def test_all_timing_fields_exist(self):
        turn = TurnLatency(call_sid_partial="CA1234")
        # Original fields
        assert hasattr(turn, "router_ms")
        assert hasattr(turn, "prefetch_ms")
        assert hasattr(turn, "filler_ms")
        assert hasattr(turn, "tools_ms")
        assert hasattr(turn, "openai_first_token_ms")
        assert hasattr(turn, "total_ms")
        # New fields
        assert hasattr(turn, "call_setup_ms")
        assert hasattr(turn, "caller_profile_lookup_ms")
        assert hasattr(turn, "shopify_api_ms")
        assert hasattr(turn, "resend_api_ms")

    def test_new_fields_default_to_zero(self):
        turn = TurnLatency(call_sid_partial="CA1234")
        assert turn.call_setup_ms == 0.0
        assert turn.caller_profile_lookup_ms == 0.0
        assert turn.shopify_api_ms == 0.0
        assert turn.resend_api_ms == 0.0

    def test_new_fields_are_settable(self):
        turn = TurnLatency(call_sid_partial="CA1234")
        turn.call_setup_ms = 123.4
        turn.caller_profile_lookup_ms = 45.6
        turn.shopify_api_ms = 789.0
        turn.resend_api_ms = 12.3
        assert turn.call_setup_ms == pytest.approx(123.4)
        assert turn.caller_profile_lookup_ms == pytest.approx(45.6)
        assert turn.shopify_api_ms == pytest.approx(789.0)
        assert turn.resend_api_ms == pytest.approx(12.3)

    def test_default_intent_is_unknown(self):
        turn = TurnLatency(call_sid_partial="X")
        assert turn.intent == "unknown"

    def test_total_ms_starts_at_zero(self):
        turn = TurnLatency(call_sid_partial="X")
        assert turn.total_ms == 0.0


# ── LatencyTracer ─────────────────────────────────────────────────────────────

class TestLatencyTracer:
    def test_start_turn_returns_turn(self):
        tracer = LatencyTracer()
        turn = tracer.start_turn("CAtest123")
        assert isinstance(turn, TurnLatency)
        assert turn.call_sid_partial == "CAtest"

    def test_finish_populates_total_ms(self):
        tracer = LatencyTracer()
        turn = tracer.start_turn("CAtest456")
        tracer.finish(turn)
        # total_ms is set by finish(). On Windows two consecutive monotonic()
        # calls can return 0 difference due to clock resolution; allow >= 0.
        assert isinstance(turn.total_ms, float)
        assert turn.total_ms >= 0

    def test_structured_log_no_pii(self, caplog):
        tracer = LatencyTracer()
        turn = tracer.start_turn("CA_SENS")
        turn.intent = "isbn_search"
        turn.router_ms = 0.5
        turn.openai_first_token_ms = 250.0

        with caplog.at_level(logging.INFO, logger="app.pipeline.latency"):
            tracer.finish(turn)

        log_output = " ".join(caplog.messages)
        # Verify structured fields are present
        assert "isbn_search" in log_output
        assert "CA_SENS"[:6] in log_output
        # Must not contain PII placeholders
        assert "@" not in log_output
        assert "password" not in log_output.lower()
        assert "token" not in log_output.lower()

    def test_optional_fields_logged_when_set(self, caplog):
        tracer = LatencyTracer()
        turn = tracer.start_turn("CA_OPT1")
        turn.call_setup_ms = 150.0
        turn.shopify_api_ms = 300.0

        with caplog.at_level(logging.INFO, logger="app.pipeline.latency"):
            tracer.finish(turn)

        log_output = " ".join(caplog.messages)
        assert "call_setup" in log_output
        assert "shopify" in log_output

    def test_optional_fields_omitted_when_zero(self, caplog):
        tracer = LatencyTracer()
        turn = tracer.start_turn("CA_OPT2")
        # All optional fields stay at 0.0

        with caplog.at_level(logging.INFO, logger="app.pipeline.latency"):
            tracer.finish(turn)

        log_output = " ".join(caplog.messages)
        # Optional extras should not appear when zero
        assert "call_setup" not in log_output
        assert "shopify" not in log_output
        assert "resend" not in log_output

    def test_mark_returns_elapsed(self):
        tracer = LatencyTracer()
        turn = tracer.start_turn("CA_MRK1")
        elapsed = tracer.mark(turn, "my_checkpoint")
        assert elapsed >= 0
        assert "my_checkpoint" in turn._checkpoints

    def test_get_tracer_singleton(self):
        t1 = get_tracer()
        t2 = get_tracer()
        assert t1 is t2

    def test_resend_api_ms_logged_when_set(self, caplog):
        tracer = LatencyTracer()
        turn = tracer.start_turn("CA_RES1")
        turn.resend_api_ms = 88.5

        with caplog.at_level(logging.INFO, logger="app.pipeline.latency"):
            tracer.finish(turn)

        log_output = " ".join(caplog.messages)
        assert "resend" in log_output
