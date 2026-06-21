"""
Unit tests for TurnTracer and VoiceTurnTrace.
"""
import time
import pytest
from app.voice.tracer import TurnTracer, VoiceTurnTrace


@pytest.fixture()
def tracer():
    return TurnTracer(
        call_sid="CA123",
        agent_id="agent-1",
        tenant_id="tenant-1",
        transcript="find me a book about python",
    )


class TestTurnTracer:
    def test_turn_id_is_uuid(self, tracer):
        assert len(tracer.turn_id) == 36
        assert tracer.turn_id.count("-") == 4

    def test_set_intent(self, tracer):
        tracer.set_intent("product_search", 0.90, {"product_query": "python"})
        trace = tracer.finalize()
        assert trace.intent == "product_search"
        assert trace.intent_confidence == 0.90
        assert trace.entities["product_query"] == "python"

    def test_tool_launched_registers_trace(self, tracer):
        tt = tracer.tool_launched("product_search", {"query": "python"})
        assert tt.name == "product_search"
        assert tt.from_cache is False
        assert tt.completed_at_ms is None

    def test_mark_complete_sets_latency(self, tracer):
        tt = tracer.tool_launched("product_search", {"query": "python"})
        time.sleep(0.01)
        tt.mark_complete(failed=False)
        assert tt.latency_ms is not None
        assert tt.latency_ms >= 0
        assert tt.failed is False

    def test_mark_complete_failure(self, tracer):
        tt = tracer.tool_launched("order_lookup", {"order_name": "#1234"})
        tt.mark_complete(failed=True, error="timeout")
        assert tt.failed is True
        assert tt.error == "timeout"

    def test_cache_hit_flag(self, tracer):
        tt = tracer.tool_launched("product_search", {"query": "python"})
        tt.mark_complete(failed=False, from_cache=True)
        assert tt.from_cache is True

    def test_finalize_produces_trace(self, tracer):
        tracer.set_intent("product_search", 0.85, {})
        tracer.set_response_mode("llm")
        trace = tracer.finalize()
        assert isinstance(trace, VoiceTurnTrace)
        assert trace.response_mode == "llm"
        assert trace.fallback_reason is None

    def test_fallback_mode(self, tracer):
        tracer.set_response_mode("fallback", "llm_timeout")
        trace = tracer.finalize()
        assert trace.response_mode == "fallback"
        assert trace.fallback_reason == "llm_timeout"

    def test_total_latency_is_positive(self, tracer):
        time.sleep(0.005)
        trace = tracer.finalize()
        assert trace.total_latency_ms >= 0


class TestVoiceTurnTrace:
    def _make_trace(self):
        tracer = TurnTracer("CA999", "a1", "t1", "hello")
        tracer.tool_launched("product_search", {}).mark_complete(failed=False)
        tracer.tool_launched("order_lookup", {}).mark_complete(failed=True, error="timeout")
        tt = tracer.tool_launched("recommendation", {})
        tt.mark_complete(failed=False, from_cache=True)
        return tracer.finalize()

    def test_launched_tools(self):
        t = self._make_trace()
        assert set(t.launched_tools) == {"product_search", "order_lookup", "recommendation"}

    def test_completed_tools(self):
        t = self._make_trace()
        assert set(t.completed_tools) == {"product_search", "recommendation"}

    def test_failed_tools(self):
        t = self._make_trace()
        assert t.failed_tools == ["order_lookup"]

    def test_cache_hits(self):
        t = self._make_trace()
        assert t.cache_hits == ["recommendation"]

    def test_to_log_dict_keys(self):
        t = self._make_trace()
        d = t.to_log_dict()
        required = {
            "turn_id", "call_sid", "agent_id", "tenant_id",
            "intent", "intent_confidence", "entities",
            "launched_tools", "completed_tools", "failed_tools", "cache_hits",
            "tool_latencies_ms", "total_latency_ms", "latency_breakdown",
            "response_mode", "fallback_reason",
        }
        assert required.issubset(d.keys())

    def test_record_step(self, tracer):
        tracer.record_step("bootstrap_parallel", 12, success=True)
        trace = tracer.finalize()
        assert trace.latency_breakdown["bootstrap_parallel"] == 12
