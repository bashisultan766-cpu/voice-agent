"""
v4.2 tests — ResponsePlanWorker.

Verifies that the planner produces correct action directives
based on session state and worker bundle.
"""
from __future__ import annotations

import os
import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.state.models import SessionState
from app.workers.response_plan_worker import ResponsePlanWorker
from app.workers.base import WorkerBundle, WorkerResult


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="s-rp", call_sid="CA_RP01",
        from_number="+15551234567", to_number="+18005551234",
        **kwargs,
    )


def _settings():
    from app.config import Settings
    return Settings(OPENAI_API_KEY="test", DEBUG=True)


def _bundle_with(worker_name: str, summary: str) -> WorkerBundle:
    b = WorkerBundle()
    b.results[worker_name] = WorkerResult(
        worker_name=worker_name,
        success=True,
        safe_summary=summary,
        source="local",
    )
    return b


class TestResponsePlanWorker:
    async def test_greet_action(self):
        worker = ResponsePlanWorker()
        session = _session()
        r = await worker.run(session, {"intent": "greeting"}, _settings(), worker_bundle=WorkerBundle())
        assert r.success
        assert session.response_plan["action"] in ("greet", "clarify")

    async def test_email_confirmation_in_progress(self):
        worker = ResponsePlanWorker()
        session = _session(
            payment_flow_status="awaiting_email_confirmation",
            pending_email="alice@example.com",
        )
        r = await worker.run(session, {}, _settings(), worker_bundle=WorkerBundle())
        assert r.success
        plan = session.response_plan
        assert plan["action"] == "confirm_email"
        assert "masked_email" in plan

    async def test_isbn_in_progress(self):
        worker = ResponsePlanWorker()
        session = _session(isbn_buffer="9781400")
        r = await worker.run(session, {}, _settings(), worker_bundle=WorkerBundle())
        plan = session.response_plan
        assert plan["action"] == "ask_continue_isbn"
        assert "9781400" in plan.get("say", "")

    async def test_product_found_in_bundle(self):
        worker = ResponsePlanWorker()
        session = _session()
        bundle = _bundle_with("product_isbn", "Found Dune by Frank Herbert — $14.99.")
        r = await worker.run(session, {}, _settings(), worker_bundle=bundle)
        plan = session.response_plan
        assert plan["action"] == "confirm_product"
        assert "Dune" in plan.get("say", "")

    async def test_order_found_in_bundle(self):
        worker = ResponsePlanWorker()
        session = _session()
        bundle = _bundle_with("order_lookup", "Order #1042 shipped on June 10.")
        r = await worker.run(session, {}, _settings(), worker_bundle=bundle)
        plan = session.response_plan
        assert plan["action"] == "order_status"

    async def test_payment_sent_action(self):
        worker = ResponsePlanWorker()
        session = _session(
            payment_flow_status="payment_sent",
        )
        r = await worker.run(session, {}, _settings(), worker_bundle=WorkerBundle())
        plan = session.response_plan
        assert plan["action"] == "payment_sent"

    async def test_clarify_when_no_data(self):
        worker = ResponsePlanWorker()
        session = _session()
        r = await worker.run(session, {}, _settings(), worker_bundle=WorkerBundle())
        assert r.success
        assert session.response_plan["action"] in ("clarify", "greet")

    async def test_ask_email_when_payment_requested_without_email(self):
        worker = ResponsePlanWorker()
        session = _session(last_product_title="Dune")
        # payment_safety worker returned missing=["confirmed_email"]
        bundle = WorkerBundle()
        bundle.results["payment_safety"] = WorkerResult(
            worker_name="payment_safety",
            success=False,
            error_code="missing_fields",
            data={"missing": ["confirmed_email"]},
            source="local",
        )
        r = await worker.run(session, {}, _settings(), worker_bundle=bundle)
        plan = session.response_plan
        assert plan["action"] == "ask_email"
