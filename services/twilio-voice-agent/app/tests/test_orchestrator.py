"""
Tests for app/workers/orchestrator.py — WorkerOrchestrator.

Verifies:
- Correct workers selected for each intent.
- Workers run concurrently (not sequentially).
- Per-worker timeout returns partial bundle.
- Failed worker does not crash the orchestrator.
- Empty intent returns empty bundle.
- No OpenAI calls made.
"""
from __future__ import annotations

import asyncio
import os
import time
import pytest
from unittest.mock import AsyncMock, patch, MagicMock

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.workers.orchestrator import WorkerOrchestrator, WORKER_PATH_INTENTS, _INTENT_WORKERS
from app.workers.base import WorkerResult, WorkerBundle
from app.pipeline.router import IntentResult
from app.pipeline.tasks import Intent
from app.state.models import SessionState


def _make_session(**kwargs) -> SessionState:
    defaults = dict(
        session_id="s-orch",
        call_sid="CA_ORCH01",
        from_number="+15551234567",
        to_number="+18005551234",
    )
    defaults.update(kwargs)
    return SessionState(**defaults)


def _make_settings(**overrides):
    from app.config import Settings
    defaults = dict(OPENAI_API_KEY="test", DEBUG=True, VOICE_TOOL_TIMEOUT_MS=2500)
    defaults.update(overrides)
    return Settings(**defaults)


def _intent_result(intent: str, entities=None, confidence=0.9) -> IntentResult:
    return IntentResult(
        intent=intent,
        confidence=confidence,
        entities=entities or {},
        needs_filler=True,
        suggested_tools=[],
    )


# ── Intent → worker selection ──────────────────────────────────────────────────

class TestIntentWorkerMapping:
    def test_isbn_search_selects_product_isbn(self):
        assert "product_isbn" in _INTENT_WORKERS["isbn_search"]

    def test_product_search_selects_product_search(self):
        assert "product_search" in _INTENT_WORKERS["product_search"]

    def test_author_search_selects_product_search(self):
        assert "product_search" in _INTENT_WORKERS["author_search"]

    def test_order_lookup_selects_caller_identity_and_order(self):
        workers = _INTENT_WORKERS["order_lookup"]
        assert "caller_identity" in workers
        assert "order_lookup" in workers

    def test_refund_status_selects_refund_worker(self):
        workers = _INTENT_WORKERS["refund_status"]
        assert "refund" in workers
        assert "order_lookup" in workers

    def test_checkout_selects_payment_flow(self):
        workers = _INTENT_WORKERS["checkout_request"]
        assert "payment_flow" in workers

    def test_send_payment_link_selects_payment_flow(self):
        assert "payment_flow" in _INTENT_WORKERS["send_payment_link"]

    def test_payment_execute_selects_payment_flow(self):
        assert "payment_flow" in _INTENT_WORKERS["payment_execute"]

    def test_shipping_question_selects_store_policy_and_shipping(self):
        workers = _INTENT_WORKERS["shipping_question"]
        assert "store_policy" in workers
        assert "shipping" in workers

    def test_escalation_selects_escalation_worker(self):
        assert "escalation" in _INTENT_WORKERS["escalation"]

    def test_greeting_has_workers(self):
        # v4.2: greeting now has lightweight workers (no fallback to run_agent_turn)
        assert len(_INTENT_WORKERS["greeting"]) > 0
        assert "conversation_memory" in _INTENT_WORKERS["greeting"] or \
               "speech_cleanup" in _INTENT_WORKERS["greeting"]

    def test_unknown_has_workers(self):
        # v4.2: unknown now has lightweight workers
        assert len(_INTENT_WORKERS["unknown"]) > 0

    def test_worker_path_intents_includes_all_intents(self):
        # v4.2: ALL intents use worker path; run_agent_turn not called in live voice
        conversational = {"greeting", "confirmation", "email_capture", "unknown"}
        for intent in conversational:
            assert intent in WORKER_PATH_INTENTS, f"{intent} should be in WORKER_PATH_INTENTS"


# ── Orchestrator runs workers ──────────────────────────────────────────────────

class TestOrchestratorRunning:
    async def test_greeting_intent_runs_lightweight_workers(self):
        # v4.2: greeting has workers (speech_cleanup, conversation_memory, etc.)
        orch = WorkerOrchestrator()
        session = _make_session()
        bundle = await orch.run(_intent_result("greeting"), session, _make_settings())
        # Workers ran (lightweight ones, not empty)
        assert len(bundle.workers_ran) > 0
        # response_plan worker always runs in wave 2
        assert "response_plan" in bundle.results

    async def test_product_isbn_worker_is_called(self):
        orch = WorkerOrchestrator()
        session = _make_session()
        success_result = WorkerResult(
            worker_name="product_isbn", success=True, safe_summary="Found Dune.", source="cache"
        )
        with patch("app.workers.orchestrator._REGISTRY") as mock_registry:
            mock_worker = MagicMock()
            mock_worker.run = AsyncMock(return_value=success_result)
            mock_registry.get = MagicMock(return_value=mock_worker)
            mock_registry.__contains__ = MagicMock(return_value=True)
            # Actually run with real registry but mock the worker
            pass

        # Use real registry but stub the individual worker
        with patch.object(orch._orchestrator if hasattr(orch, "_orchestrator") else orch,
                          "run", wraps=orch.run) if False else patch("app.workers.product_isbn_worker.ProductISBNWorker.run",
                          AsyncMock(return_value=success_result)):
            bundle = await orch.run(
                _intent_result("isbn_search", {"isbn": "9780441172719"}),
                session,
                _make_settings(),
            )
        assert "product_isbn" in bundle.workers_ran

    async def test_failed_worker_does_not_crash(self):
        orch = WorkerOrchestrator()
        session = _make_session()
        with patch("app.workers.caller_identity_worker.CallerIdentityWorker.run",
                   AsyncMock(side_effect=RuntimeError("worker crashed"))), \
             patch("app.workers.order_lookup_worker.OrderLookupWorker.run",
                   AsyncMock(side_effect=RuntimeError("worker crashed"))), \
             patch("app.workers.tracking_worker.TrackingWorker.run",
                   AsyncMock(side_effect=RuntimeError("worker crashed"))):
            bundle = await orch.run(_intent_result("order_lookup"), session, _make_settings())
        # Should return a bundle without crashing
        assert isinstance(bundle, WorkerBundle)

    async def test_timeout_returns_partial_bundle(self):
        orch = WorkerOrchestrator()
        session = _make_session()

        async def slow_run(self, session, entities, settings):
            await asyncio.sleep(10)
            return WorkerResult(worker_name="product_isbn", success=True)

        with patch("app.workers.product_isbn_worker.ProductISBNWorker.run", slow_run):
            bundle = await orch.run(
                _intent_result("isbn_search", {"isbn": "9780441172719"}),
                session,
                _make_settings(VOICE_TOOL_TIMEOUT_MS=50),  # very short timeout
            )
        result = bundle.results.get("product_isbn")
        assert result is not None
        assert result.error_code == "timeout"

    async def test_workers_run_concurrently(self):
        """Workers for order_lookup run in parallel, not sequentially."""
        orch = WorkerOrchestrator()
        session = _make_session()
        start_times = []

        async def timed_run(self, session, entities, settings):
            start_times.append(time.monotonic())
            await asyncio.sleep(0.05)
            return WorkerResult(worker_name="fake", success=True, source="cache")

        with patch("app.workers.caller_identity_worker.CallerIdentityWorker.run", timed_run), \
             patch("app.workers.order_lookup_worker.OrderLookupWorker.run", timed_run), \
             patch("app.workers.tracking_worker.TrackingWorker.run", timed_run):
            t0 = time.monotonic()
            await orch.run(_intent_result("order_lookup"), session, _make_settings())
            elapsed = time.monotonic() - t0

        # All 3 workers run concurrently — total should be ~50ms, not ~150ms.
        assert elapsed < 0.12, f"Workers appear to run sequentially: {elapsed:.3f}s"
        assert len(start_times) == 3

    async def test_bundle_records_shopify_latency(self):
        orch = WorkerOrchestrator()
        session = _make_session()

        async def shopify_run(self, session, entities, settings):
            return WorkerResult(
                worker_name="product_isbn",
                success=True,
                source="shopify",
                latency_ms=400.0,
            )

        with patch("app.workers.product_isbn_worker.ProductISBNWorker.run", shopify_run):
            bundle = await orch.run(
                _intent_result("isbn_search", {"isbn": "9780441172719"}),
                session,
                _make_settings(),
            )
        assert bundle.shopify_api_ms == pytest.approx(400.0)

    async def test_bundle_records_resend_latency(self):
        orch = WorkerOrchestrator()
        session = _make_session()
        session.pending_checkout_url = "https://example.com/pay/1"
        session.confirmed_email = "alice@example.com"
        session.cart_items = [{
            "title": "Book", "variant_id": "gid://1", "quantity": 1,
            "confirmation_status": "confirmed",
        }]
        session.payment_flow_status = "awaiting_send_confirmation"

        async def resend_run(self, session, entities, settings):
            return WorkerResult(
                worker_name="payment_flow",
                success=True,
                source="resend",
                latency_ms=300.0,
            )

        with patch("app.workers.payment_flow_worker.PaymentFlowWorker.run", resend_run):
            bundle = await orch.run(
                _intent_result("payment_execute", {}),
                session,
                _make_settings(),
            )
        assert bundle.resend_api_ms == pytest.approx(300.0)

    async def test_no_openai_called_during_orchestration(self):
        """Orchestrator must never call OpenAI."""
        orch = WorkerOrchestrator()
        session = _make_session()

        with patch("openai.AsyncOpenAI") as mock_openai:
            await orch.run(_intent_result("isbn_search"), session, _make_settings())

        mock_openai.assert_not_called()
