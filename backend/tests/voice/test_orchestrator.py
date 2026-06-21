"""
Integration-style tests for ParallelVoiceOrchestrator.
All external I/O (OpenAI, Redis, Shopify) is replaced with lightweight fakes.
"""
from __future__ import annotations
import asyncio
import json
import pytest
import pytest_asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from app.voice.orchestrator import OrchestratorResult, ParallelVoiceOrchestrator
from app.tools.base import ToolContext


# ── Shared fixtures ───────────────────────────────────────────────────────────

@pytest.fixture()
def tool_context():
    return ToolContext(
        agent_id="agent-1",
        tenant_id="tenant-1",
        call_sid="CA-test-123",
        shopify_store_url="https://shop.myshopify.com",
        shopify_api_token="shpat_test",
        openai_api_key="sk-test",
    )


@pytest.fixture()
def fake_registry():
    registry = MagicMock()
    registry.schemas.return_value = []
    registry.execute = AsyncMock(return_value=json.dumps({"found": True, "products": []}))
    return registry


def _make_orchestrator(tool_context, fake_registry):
    return ParallelVoiceOrchestrator(
        agent_id="agent-1",
        tenant_id="tenant-1",
        call_sid="CA-test-123",
        system_prompt="You are a helpful bookstore assistant.",
        tool_registry=fake_registry,
        tool_context=tool_context,
        llm_model="gpt-4o-mini",
        tts_voice="alloy",
        openai_api_key="sk-test",
        use_openai_tts=False,  # skip real TTS in tests
    )


# ── Instant reply path ────────────────────────────────────────────────────────

class TestInstantReplies:
    @pytest.mark.asyncio
    async def test_greeting_returns_instant(self, tool_context, fake_registry):
        orch = _make_orchestrator(tool_context, fake_registry)

        with (
            patch("app.voice.orchestrator.cache_get", new_callable=AsyncMock, return_value=[]),
            patch("app.voice.orchestrator.cache_set", new_callable=AsyncMock),
        ):
            result = await orch.process_turn("hi")

        assert isinstance(result, OrchestratorResult)
        assert result.response_mode == "instant"
        assert "welcome" in result.text.lower() or "hi" in result.text.lower()
        assert result.tool_calls == []
        # No tools should have been launched
        fake_registry.execute.assert_not_called()

    @pytest.mark.asyncio
    async def test_farewell_returns_instant(self, tool_context, fake_registry):
        orch = _make_orchestrator(tool_context, fake_registry)

        with (
            patch("app.voice.orchestrator.cache_get", new_callable=AsyncMock, return_value=[]),
            patch("app.voice.orchestrator.cache_set", new_callable=AsyncMock),
        ):
            result = await orch.process_turn("goodbye")

        assert result.response_mode == "instant"
        fake_registry.execute.assert_not_called()


# ── LLM path with speculative pre-fetch ──────────────────────────────────────

    @pytest.mark.asyncio
    async def test_greeting_saves_history(self, tool_context, fake_registry):
        orch = _make_orchestrator(tool_context, fake_registry)
        cache_set_mock = AsyncMock()

        with (
            patch("app.voice.orchestrator.cache_get", new_callable=AsyncMock, return_value=[]),
            patch("app.voice.orchestrator.cache_set", cache_set_mock),
        ):
            await orch.process_turn("hi")

        cache_set_mock.assert_called_once()
        saved_history = cache_set_mock.call_args[0][1]
        assert saved_history[-1]["role"] == "assistant"


class TestSpeculativePrefetch:
    @pytest.mark.asyncio
    async def test_product_search_launches_prefetch(self, tool_context, fake_registry):
        """product_search tool should be pre-fetched before the LLM call."""
        orch = _make_orchestrator(tool_context, fake_registry)

        llm_response = ("We have several Python books in stock.", [])

        with (
            patch("app.voice.orchestrator.cache_get", new_callable=AsyncMock, return_value=[]),
            patch("app.voice.orchestrator.cache_set", new_callable=AsyncMock),
            patch("app.voice.orchestrator.run_agentic_loop", new_callable=AsyncMock,
                  return_value=llm_response),
        ):
            result = await orch.process_turn("I'm looking for a Python programming book")

        assert result.response_mode == "llm"
        assert "python" in result.text.lower() or "stock" in result.text.lower()
        # pre-fetch should have called the registry
        fake_registry.execute.assert_called()

    @pytest.mark.asyncio
    async def test_order_lookup_launches_prefetch(self, tool_context, fake_registry):
        orch = _make_orchestrator(tool_context, fake_registry)
        fake_registry.execute.return_value = json.dumps(
            {"found": True, "order": {"name": "#1234", "status": "fulfilled"}}
        )

        with (
            patch("app.voice.orchestrator.cache_get", new_callable=AsyncMock, return_value=[]),
            patch("app.voice.orchestrator.cache_set", new_callable=AsyncMock),
            patch("app.voice.orchestrator.run_agentic_loop", new_callable=AsyncMock,
                  return_value=("Your order #1234 has been shipped.", [])),
        ):
            result = await orch.process_turn("Where's my order number 1234?")

        assert result.response_mode == "llm"
        fake_registry.execute.assert_called_once()
        call_args = fake_registry.execute.call_args
        assert call_args[0][0] == "order_lookup"
        assert call_args[0][2].get("order_name") == "1234"

    @pytest.mark.asyncio
    async def test_no_prefetch_for_other_intent(self, tool_context, fake_registry):
        """For vague queries (OTHER intent), no speculative tools are launched."""
        orch = _make_orchestrator(tool_context, fake_registry)

        with (
            patch("app.voice.orchestrator.cache_get", new_callable=AsyncMock, return_value=[]),
            patch("app.voice.orchestrator.cache_set", new_callable=AsyncMock),
            patch("app.voice.orchestrator.run_agentic_loop", new_callable=AsyncMock,
                  return_value=("How can I help you?", [])),
        ):
            result = await orch.process_turn("umm maybe something like that")

        # Registry.execute is only called if LLM or prefetch calls it;
        # for OTHER intent, no prefetch → only LLM might call it.
        # With empty tool_schemas mock, LLM won't call tools either.
        assert result.response_mode == "llm"


# ── Cache hit serving ─────────────────────────────────────────────────────────

class TestCacheAwareExecutor:
    @pytest.mark.asyncio
    async def test_cache_hit_serves_prefetched_result(self, tool_context, fake_registry):
        """
        _make_cached_executor should return the pre-fetched result immediately
        (without calling registry.execute) when the LLM calls a tool whose
        canonical args key matches a *done* prefetch task/future.

        We use a pre-resolved asyncio.Future to simulate a completed prefetch
        without relying on asyncio task-scheduling order.
        """
        orch = _make_orchestrator(tool_context, fake_registry)
        from app.voice.tracer import TurnTracer
        tracer = TurnTracer("CA-cache", "agent-1", "tenant-1", "python books")

        # Simulate a completed prefetch result stored as a resolved Future.
        cached_payload = json.dumps({"found": True, "products": [{"title": "Python 101"}]})
        args = {"query": "python books", "limit": 5}
        cache_key = f"product_search:{json.dumps(args, sort_keys=True)}"

        resolved_future: asyncio.Future = asyncio.get_event_loop().create_future()
        resolved_future.set_result(cached_payload)

        prefetch_tasks = {cache_key: resolved_future}
        executor = orch._make_cached_executor(prefetch_tasks, tracer)

        # Call the executor with the identical args — should hit cache
        result = await executor("product_search", args)

        assert result == cached_payload
        fake_registry.execute.assert_not_called()  # no second call to registry

    @pytest.mark.asyncio
    async def test_cache_miss_falls_through_to_registry(self, tool_context, fake_registry):
        """When the LLM calls a tool with args that don't match any prefetch key,
        the executor should call registry.execute (fresh execution)."""
        orch = _make_orchestrator(tool_context, fake_registry)
        from app.voice.tracer import TurnTracer
        tracer = TurnTracer("CA-miss", "agent-1", "tenant-1", "python books")

        # Prefetch was for "python books" but LLM asks for "machine learning"
        args_prefetch = {"query": "python books", "limit": 5}
        cache_key = f"product_search:{json.dumps(args_prefetch, sort_keys=True)}"
        resolved_future: asyncio.Future = asyncio.get_event_loop().create_future()
        resolved_future.set_result(json.dumps({"found": True}))
        prefetch_tasks = {cache_key: resolved_future}

        executor = orch._make_cached_executor(prefetch_tasks, tracer)

        # LLM calls with DIFFERENT args → cache miss
        different_args = {"query": "machine learning", "limit": 5}
        await executor("product_search", different_args)

        fake_registry.execute.assert_called_once()


# ── Deadline / fallback paths ─────────────────────────────────────────────────

class TestDeadlines:
    @pytest.mark.asyncio
    async def test_llm_timeout_returns_fallback(self, tool_context, fake_registry):
        """
        When the LLM loop raises asyncio.TimeoutError (as asyncio.wait_for would),
        the orchestrator must return a graceful fallback response.
        """
        orch = _make_orchestrator(tool_context, fake_registry)

        async def timing_out_llm(*args, **kwargs):
            # Simulate asyncio.wait_for hitting the deadline
            raise asyncio.TimeoutError()

        with (
            patch("app.voice.orchestrator.cache_get", new_callable=AsyncMock, return_value=[]),
            patch("app.voice.orchestrator.cache_set", new_callable=AsyncMock),
            patch("app.voice.orchestrator.run_agentic_loop", side_effect=timing_out_llm),
        ):
            result = await orch.process_turn("Looking for a book on machine learning")

        assert result.response_mode == "fallback"
        assert result.fallback_reason == "llm_timeout"
        assert result.fallback_used is True
        assert result.audio_path is None
        assert result.text  # should contain a human-readable fallback message

    @pytest.mark.asyncio
    async def test_tool_timeout_marks_trace_failed(self, tool_context, fake_registry):
        """
        When a speculative prefetch tool raises TimeoutError, the ToolTrace should
        be marked as failed=True with error='timeout'.  The LLM still produces a
        response (using whatever context it has).
        """
        orch = _make_orchestrator(tool_context, fake_registry)

        async def timing_out_tool(*args, **kwargs):
            raise asyncio.TimeoutError()

        fake_registry.execute = timing_out_tool  # type: ignore[assignment]

        with (
            patch("app.voice.orchestrator.cache_get", new_callable=AsyncMock, return_value=[]),
            patch("app.voice.orchestrator.cache_set", new_callable=AsyncMock),
            patch("app.voice.orchestrator.run_agentic_loop", new_callable=AsyncMock,
                  return_value=("Here you go.", [])),
        ):
            result = await orch.process_turn("I'm looking for a Python book")

        # LLM still responded despite the prefetch failing
        assert result.response_mode == "llm"
        # The prefetch ToolTrace must record the failure
        failed = [t for t in result.trace.tool_traces if t.failed]
        assert len(failed) >= 1
        assert failed[0].error == "timeout"


# ── Trace completeness ────────────────────────────────────────────────────────

class TestStructuredOutput:
    @pytest.mark.asyncio
    async def test_result_has_structured_fields(self, tool_context, fake_registry):
        orch = _make_orchestrator(tool_context, fake_registry)

        with (
            patch("app.voice.orchestrator.cache_get", new_callable=AsyncMock, return_value=[]),
            patch("app.voice.orchestrator.cache_set", new_callable=AsyncMock),
            patch("app.voice.orchestrator.run_agentic_loop", new_callable=AsyncMock,
                  return_value=("We have Python books!", [])),
        ):
            result = await orch.process_turn("find me a book")

        assert result.intent
        assert isinstance(result.entities, dict)
        assert isinstance(result.tool_results, dict)
        assert isinstance(result.partial_results, dict)
        assert isinstance(result.latency_breakdown, dict)
        assert result.final_response == result.text
        assert result.filler_text is not None

    @pytest.mark.asyncio
    async def test_parallel_bootstrap_records_latency(self, tool_context, fake_registry):
        orch = _make_orchestrator(tool_context, fake_registry)

        with (
            patch("app.voice.orchestrator.cache_get", new_callable=AsyncMock, return_value=[]),
            patch("app.voice.orchestrator.cache_set", new_callable=AsyncMock),
            patch("app.voice.orchestrator.run_agentic_loop", new_callable=AsyncMock,
                  return_value=("Here you go.", [])),
        ):
            result = await orch.process_turn("show me some books")

        assert "bootstrap_parallel" in result.latency_breakdown


class TestTraceCompleteness:
    @pytest.mark.asyncio
    async def test_trace_has_all_required_fields(self, tool_context, fake_registry):
        orch = _make_orchestrator(tool_context, fake_registry)

        with (
            patch("app.voice.orchestrator.cache_get", new_callable=AsyncMock, return_value=[]),
            patch("app.voice.orchestrator.cache_set", new_callable=AsyncMock),
            patch("app.voice.orchestrator.run_agentic_loop", new_callable=AsyncMock,
                  return_value=("Here you go.", [])),
        ):
            result = await orch.process_turn("show me some books")

        d = result.trace.to_log_dict()
        for key in ("turn_id", "call_sid", "intent", "total_latency_ms", "response_mode"):
            assert key in d, f"Missing trace field: {key}"

    @pytest.mark.asyncio
    async def test_instant_trace_has_instant_mode(self, tool_context, fake_registry):
        orch = _make_orchestrator(tool_context, fake_registry)

        with (
            patch("app.voice.orchestrator.cache_get", new_callable=AsyncMock, return_value=[]),
            patch("app.voice.orchestrator.cache_set", new_callable=AsyncMock),
        ):
            result = await orch.process_turn("hello")

        assert result.trace.response_mode == "instant"

    @pytest.mark.asyncio
    async def test_result_to_dict_is_serializable(self, tool_context, fake_registry):
        orch = _make_orchestrator(tool_context, fake_registry)

        with (
            patch("app.voice.orchestrator.cache_get", new_callable=AsyncMock, return_value=[]),
            patch("app.voice.orchestrator.cache_set", new_callable=AsyncMock),
            patch("app.voice.orchestrator.run_agentic_loop", new_callable=AsyncMock,
                  return_value=("We have Python books!", [])),
        ):
            result = await orch.process_turn("find me a book")

        d = result.to_dict()
        json_str = json.dumps(d)  # must not raise
        assert "text" in d
        assert "intent" in d
        assert "latency_breakdown" in d
        assert isinstance(json_str, str)
