"""
Tests for app/pipeline/latency.py — TurnLatency and LatencyTracer.
"""
from __future__ import annotations

import logging
import os
import time
import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.pipeline.latency import LatencyTracer, TurnLatency, get_tracer


class TestTurnLatency:
    def test_default_fields(self):
        turn = TurnLatency(call_sid_partial="CA1234")
        assert turn.intent == "unknown"
        assert turn.router_ms == 0.0
        assert turn.total_ms == 0.0

    def test_call_sid_partial_stored(self):
        turn = TurnLatency(call_sid_partial="CAABCD")
        assert turn.call_sid_partial == "CAABCD"

    def test_has_internal_start_time(self):
        turn = TurnLatency(call_sid_partial="X")
        assert turn._start > 0

    def test_checkpoints_dict_empty_by_default(self):
        turn = TurnLatency(call_sid_partial="X")
        assert turn._checkpoints == {}


class TestLatencyTracer:
    def test_start_turn_returns_turn_latency(self):
        tracer = LatencyTracer()
        turn = tracer.start_turn("CA_TEST123", "product_search")
        assert isinstance(turn, TurnLatency)
        assert turn.intent == "product_search"
        assert turn.call_sid_partial == "CA_TES"

    def test_call_sid_truncated_to_6(self):
        tracer = LatencyTracer()
        turn = tracer.start_turn("CA_LONGCALLSID")
        assert turn.call_sid_partial == "CA_LON"

    def test_empty_call_sid_fallback(self):
        tracer = LatencyTracer()
        turn = tracer.start_turn("")
        assert turn.call_sid_partial == "??????"

    def test_mark_returns_elapsed_ms(self):
        tracer = LatencyTracer()
        turn = tracer.start_turn("CA_X", "isbn_search")
        time.sleep(0.02)
        elapsed = tracer.mark(turn, "after_router")
        assert elapsed >= 10  # slept 20ms; 10ms threshold is robust to Windows timer precision
        assert "after_router" in turn._checkpoints

    def test_finish_sets_total_ms(self):
        tracer = LatencyTracer()
        turn = tracer.start_turn("CA_X")
        # Sleep 50ms: well above the Windows timer tick (~15.625ms) so the
        # monotonic clock is guaranteed to advance before finish() is called.
        time.sleep(0.05)
        tracer.finish(turn)
        assert turn.total_ms >= 5

    def test_finish_logs_structured_line(self, caplog):
        tracer = LatencyTracer()
        turn = tracer.start_turn("CA_LOG1", "order_lookup")
        turn.router_ms = 1.2
        turn.tools_ms = 120.5
        with caplog.at_level(logging.INFO, logger="app.pipeline.latency"):
            tracer.finish(turn)
        assert "pipeline_latency" in caplog.text
        assert "order_lookup" in caplog.text

    def test_finish_logs_no_phone_or_email(self, caplog):
        tracer = LatencyTracer()
        turn = tracer.start_turn("CA_SEC1")
        with caplog.at_level(logging.DEBUG, logger="app.pipeline.latency"):
            tracer.finish(turn)
        log_text = caplog.text
        assert "@" not in log_text
        assert "+1555" not in log_text

    def test_get_tracer_returns_singleton(self):
        t1 = get_tracer()
        t2 = get_tracer()
        assert t1 is t2

    def test_multiple_turns_independent(self):
        tracer = LatencyTracer()
        t1 = tracer.start_turn("CA_A", "greeting")
        t2 = tracer.start_turn("CA_B", "order_lookup")
        t1.router_ms = 1.0
        t2.router_ms = 2.0
        assert t1.router_ms != t2.router_ms
        assert t1.intent != t2.intent
