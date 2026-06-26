"""
Step 3 orchestrator tests — supervisor, planner, tool router, feature flag.
"""
from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, patch

import pytest

from app.agent_runtime.live_runtime import resolve_live_turn_handler
from app.agent_runtime.llm_tool_runtime import RUNTIME_MODE as LLM_MODE
from app.config import Settings
from app.orchestrator.intent_router import classify_intent_heuristic
from app.orchestrator.model_router import select_model
from app.orchestrator.parallel_executor import execute_plan
from app.orchestrator.planner_agent import build_plan
from app.orchestrator.response_composer import _phone_safe, compose_response
from app.orchestrator.runtime import RUNTIME_MODE as ORCH_MODE, get_orchestrator_runtime
from app.orchestrator.tool_router import execute_step, is_read_only_tool
from app.orchestrator.types import OrchestratorTurnContext, PlanStep, PlannerResult, SupervisorResult
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    base = dict(
        session_id="orch1",
        call_sid="CA_ORCH001",
        from_number="+15551230001",
        to_number="+15559990001",
    )
    base.update(kwargs)
    return SessionState(**base)


class TestSupervisor:
    def test_classifies_isbn_search(self):
        result = classify_intent_heuristic("9780441172719", _session())
        assert result.intent == "product_search"
        assert result.needs_tools is True
        assert result.confidence >= 0.9

    def test_classifies_payment_request(self):
        result = classify_intent_heuristic("Please send me the payment link", _session())
        assert result.intent == "checkout_payment"
        assert result.risk_level == "high"
        assert result.needs_planner is True

    def test_blocks_risky_unverified_order_detail(self):
        result = classify_intent_heuristic(
            "What books are in order 12345?",
            _session(),
        )
        assert result.intent == "order_status"
        assert result.risk_level == "high"
        assert result.clarifying_question
        assert result.needs_tools is False


class TestPlanner:
    def test_parallel_product_search_plan(self):
        supervisor = SupervisorResult(
            intent="product_search",
            confidence=0.9,
            needs_tools=True,
            needs_planner=True,
        )
        plan = build_plan(
            supervisor,
            "compare Dune and Foundation",
            _session(),
        )
        assert len(plan.steps) == 2
        assert all(s.tool == "search_products" for s in plan.steps)
        assert all(s.can_run_parallel for s in plan.steps)

    def test_refuses_payment_without_confirmed_email(self):
        supervisor = SupervisorResult(intent="checkout_payment", needs_planner=True)
        session = _session(
            payment_cart_confirmed=True,
            cart_items=[{"variant_id": "v1", "quantity": 1}],
        )
        plan = build_plan(supervisor, "send payment link", session)
        assert plan.blocked is True
        assert plan.block_reason in (
            "no_email", "email_unconfirmed", "no_checkout_url", "cart_unconfirmed", "no_items",
        )


class TestToolRouter:
    @pytest.mark.asyncio
    async def test_parallel_read_only_tools(self):
        session = _session()
        plan = PlannerResult(
            steps=[
                PlanStep(tool="search_products", args={"query": "Dune"}, can_run_parallel=True),
                PlanStep(tool="search_products", args={"query": "Foundation"}, can_run_parallel=True),
            ],
        )

        async def fake_dispatch(name, args, sess):
            return json.dumps({"success": True, "products": [{"title": args.get("query", "book")}]})

        with patch("app.agent_runtime.llm_tools.dispatch", side_effect=fake_dispatch):
            results = await execute_plan(plan, session, turn_id="t1")

        assert len(results) == 2
        assert all(r.success for r in results)
        assert is_read_only_tool("search_products")

    @pytest.mark.asyncio
    async def test_applies_payment_guards(self):
        session = _session(payment_cart_confirmed=False)
        step = PlanStep(tool="send_payment_link", args={}, can_run_parallel=False)
        result = await execute_step(step, session)
        assert result.blocked_by_guard or not result.success
        assert result.error_code in ("cart_unconfirmed", "email_unconfirmed", "empty_cart", "")


class TestResponseComposer:
    @pytest.mark.asyncio
    async def test_phone_safe_text(self):
        ctx = OrchestratorTurnContext(
            user_text="hi",
            supervisor=SupervisorResult(intent="smalltalk"),
        )
        text = await compose_response(_session(), ctx, use_llm=False)
        assert "http" not in text.lower()
        assert "```" not in text
        assert "#" not in text or "SureShot" in text

    def test_strips_urls(self):
        assert "https://" not in _phone_safe("Visit https://secret.example.com/pay now")


class TestModelRouter:
    def test_fast_model_for_smalltalk(self):
        s = Settings.model_construct(
            OPENAI_FAST_MODEL="fast-mini",
            OPENAI_STRONG_MODEL="strong",
            OPENAI_MODEL="default",
            VOICE_FINAL_MODEL="",
        )
        model = select_model("composer", SupervisorResult(intent="smalltalk"), settings=s)
        assert model == "fast-mini"

    def test_fallback_model(self):
        s = Settings(OPENAI_FALLBACK_MODEL="fallback-mini", OPENAI_FAST_MODEL="fast-mini")
        model = select_model("composer", None, settings=s, use_fallback=True)
        assert model == "fallback-mini"


class TestFeatureFlag:
    def test_flag_off_keeps_llm_tool_runtime(self):
        s = Settings(VOICE_ORCHESTRATOR_ENABLED=False)
        assert resolve_live_turn_handler(s) == LLM_MODE

    def test_flag_on_uses_orchestrator(self):
        s = Settings(VOICE_ORCHESTRATOR_ENABLED=True)
        assert resolve_live_turn_handler(s) == ORCH_MODE

    @pytest.mark.asyncio
    async def test_orchestrator_handle_turn_smalltalk(self):
        runtime = get_orchestrator_runtime(Settings(OPENAI_API_KEY=""))
        session = _session()
        sent = []

        async def send(msg):
            sent.append(msg)

        result = await runtime.handle_turn(session, "Hello there", send)
        assert result.source == ORCH_MODE
        assert result.response_text
        assert any(m.get("token") for m in sent if m.get("type") == "text")
