"""v4.11 — Worker fanout and fact packet tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")


def _session(**kwargs):
    from app.state.models import SessionState
    s = SessionState(
        session_id="s411wf",
        call_sid="CA00000413",
        from_number="+15550003333",
        to_number="+15559998888",
    )
    for k, v in kwargs.items():
        setattr(s, k, v)
    return s


@pytest.mark.asyncio
class TestWorkerFanout:
    async def test_read_only_workers_parallel_capable(self):
        from app.agent_runtime.worker_packet import READ_ONLY_WORKERS
        assert "catalog_search" in READ_ONLY_WORKERS
        assert "order_lookup" in READ_ONLY_WORKERS

    async def test_mutating_workers_sequential(self):
        from app.agent_runtime.worker_packet import MUTATING_WORKERS
        assert "payment_flow" in MUTATING_WORKERS
        assert "payment_flow" not in __import__(
            "app.agent_runtime.worker_packet", fromlist=["READ_ONLY_WORKERS"]
        ).READ_ONLY_WORKERS

    async def test_payment_waits_for_confirmed_email(self):
        from app.agent_runtime.worker_fanout import _payment_ready
        session = _session(payment_flow_status="awaiting_send_confirmation", confirmed_email="")
        assert not _payment_ready(session)
        session.confirmed_email = "test@example.com"
        assert _payment_ready(session)

    async def test_fact_packet_masks_pii(self):
        from app.agent_runtime.fact_packet import build_fact_packet
        from app.workers.base import WorkerBundle, WorkerResult

        bundle = WorkerBundle()
        bundle.results["test"] = WorkerResult(
            worker_name="test",
            success=True,
            data={"email": "secret@example.com", "title": "Book Title"},
            safe_summary="Found a book",
        )
        fp = build_fact_packet(bundle)
        assert "secret@example.com" not in str(fp.business_facts)
        assert fp.sensitive_fields_masked

    async def test_worker_errors_become_safe_facts(self):
        from app.agent_runtime.fact_packet import build_fact_packet
        from app.workers.base import WorkerBundle, WorkerResult

        bundle = WorkerBundle()
        bundle.results["order_lookup"] = WorkerResult(
            worker_name="order_lookup",
            success=False,
            error_code="timeout",
        )
        fp = build_fact_packet(bundle)
        assert any("timeout" in r for r in fp.blocked_reasons)

    async def test_fanout_runs_orchestrator(self):
        from app.agent_runtime.worker_fanout import get_worker_fanout
        from app.agent_runtime.types import SupervisorDecision, WorkerRequest
        from app.pipeline.router import IntentResult

        session = _session()
        decision = SupervisorDecision(
            user_intent="vague_book_request",
            worker_requests=[WorkerRequest(worker="cart_memory")],
        )
        intent = IntentResult(intent="vague_book_request", confidence=0.9)
        bundle = await get_worker_fanout().run(decision, intent, session, __import__("app.config", fromlist=["get_settings"]).get_settings())
        assert bundle is not None
