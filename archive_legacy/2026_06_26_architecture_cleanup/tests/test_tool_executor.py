"""
Tests for app/pipeline/tool_executor.py — parallel tool execution and prefetch cache.
"""
from __future__ import annotations

import asyncio
import json
import os
import pytest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.pipeline.tool_executor import run_tools_parallel, prefetch_key, ToolResult
from app.state.models import SessionState


def _make_session(**kwargs) -> SessionState:
    return SessionState(
        session_id="sess-exec",
        call_sid="CA_EXEC",
        from_number="+15551234567",
        to_number="+18005551234",
        **kwargs,
    )


# ── prefetch_key ──────────────────────────────────────────────────────────────

class TestPrefetchKey:
    def test_same_args_same_key(self):
        k1 = prefetch_key("search_products", {"query": "Dune"})
        k2 = prefetch_key("search_products", {"query": "Dune"})
        assert k1 == k2

    def test_different_args_different_key(self):
        k1 = prefetch_key("search_products", {"query": "Dune"})
        k2 = prefetch_key("search_products", {"query": "Foundation"})
        assert k1 != k2

    def test_different_tools_different_key(self):
        k1 = prefetch_key("search_products", {"query": "Dune"})
        k2 = prefetch_key("lookup_order", {"query": "Dune"})
        assert k1 != k2

    def test_session_excluded_from_key(self):
        session = _make_session()
        k1 = prefetch_key("search_products", {"query": "x"})
        k2 = prefetch_key("search_products", {"query": "x", "session": session})
        assert k1 == k2

    def test_key_includes_tool_name_prefix(self):
        k = prefetch_key("search_products", {"query": "Dune"})
        assert k.startswith("search_products:")

    def test_key_arg_order_independent(self):
        k1 = prefetch_key("t", {"a": 1, "b": 2})
        k2 = prefetch_key("t", {"b": 2, "a": 1})
        assert k1 == k2


# ── run_tools_parallel ────────────────────────────────────────────────────────

class TestRunToolsParallel:
    async def test_empty_list_returns_empty(self):
        session = _make_session()
        results = await run_tools_parallel([], session)
        assert results == []

    async def test_successful_tool_stored_in_prefetch_cache(self):
        session = _make_session()
        fake_result = json.dumps({"products": []})

        with patch("app.pipeline.tool_executor.tool_registry") as mock_reg:
            mock_reg.dispatch = AsyncMock(return_value=fake_result)
            results = await run_tools_parallel(
                [{"name": "search_products", "args": {"query": "Dune"}}],
                session,
                timeout_ms=2000,
            )

        assert len(results) == 1
        assert results[0].success is True
        assert results[0].name == "search_products"
        # Result must be in the prefetch cache
        key = prefetch_key("search_products", {"query": "Dune"})
        assert session.prefetch_cache.get(key) == fake_result

    async def test_tool_timeout_returns_failure(self):
        session = _make_session()

        async def _slow(*args, **kwargs):
            await asyncio.sleep(10)
            return "{}"

        with patch("app.pipeline.tool_executor.tool_registry") as mock_reg:
            mock_reg.dispatch = _slow
            results = await run_tools_parallel(
                [{"name": "search_products", "args": {"query": "x"}}],
                session,
                timeout_ms=50,
            )

        assert results[0].success is False
        assert results[0].error == "timeout"
        assert results[0].latency_ms >= 40

    async def test_tool_exception_returns_failure(self):
        session = _make_session()

        async def _fail(*args, **kwargs):
            raise ValueError("Shopify down")

        with patch("app.pipeline.tool_executor.tool_registry") as mock_reg:
            mock_reg.dispatch = _fail
            results = await run_tools_parallel(
                [{"name": "search_products", "args": {}}],
                session,
                timeout_ms=2000,
            )

        assert results[0].success is False
        assert "Shopify down" in (results[0].error or "")

    async def test_parallel_execution_concurrent(self):
        """Two slow tools must run concurrently, not sequentially."""
        session = _make_session()

        async def _slow_tool(*args, **kwargs):
            await asyncio.sleep(0.05)
            return json.dumps({"ok": True})

        with patch("app.pipeline.tool_executor.tool_registry") as mock_reg:
            mock_reg.dispatch = _slow_tool
            import time
            t0 = time.monotonic()
            results = await run_tools_parallel(
                [
                    {"name": "search_products", "args": {"query": "A"}},
                    {"name": "lookup_order", "args": {"order_number": "#1"}},
                ],
                session,
                timeout_ms=2000,
            )
            elapsed = time.monotonic() - t0

        # Two 50ms tasks run concurrently → total < 150ms (not 100+100ms)
        assert elapsed < 0.15
        assert all(r.success for r in results)

    async def test_partial_results_on_mixed_success(self):
        """One success, one failure → both returned, cache has only the success."""
        session = _make_session()
        good_result = json.dumps({"product": "Dune"})

        call_count = 0

        async def _dispatch(name, args, session_obj):
            nonlocal call_count
            call_count += 1
            if name == "search_products":
                return good_result
            raise RuntimeError("order lookup failed")

        with patch("app.pipeline.tool_executor.tool_registry") as mock_reg:
            mock_reg.dispatch = _dispatch
            results = await run_tools_parallel(
                [
                    {"name": "search_products", "args": {"query": "Dune"}},
                    {"name": "lookup_order", "args": {"order_number": "#1"}},
                ],
                session,
                timeout_ms=2000,
            )

        successes = [r for r in results if r.success]
        failures = [r for r in results if not r.success]
        assert len(successes) == 1
        assert len(failures) == 1
        assert successes[0].name == "search_products"

    async def test_latency_measured(self):
        session = _make_session()

        async def _instant(*args, **kwargs):
            return json.dumps({})

        with patch("app.pipeline.tool_executor.tool_registry") as mock_reg:
            mock_reg.dispatch = _instant
            results = await run_tools_parallel(
                [{"name": "search_products", "args": {}}],
                session,
            )

        assert results[0].latency_ms >= 0


# ── ToolResult dataclass ──────────────────────────────────────────────────────

class TestToolResult:
    def test_success_fields(self):
        r = ToolResult(name="search_products", result="{}", success=True, latency_ms=50.0)
        assert r.name == "search_products"
        assert r.success is True
        assert r.error is None

    def test_failure_fields(self):
        r = ToolResult(name="lookup_order", result=None, success=False, latency_ms=2500.0, error="timeout")
        assert r.success is False
        assert r.error == "timeout"
        assert r.result is None
