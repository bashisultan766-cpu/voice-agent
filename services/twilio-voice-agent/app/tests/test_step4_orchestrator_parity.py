"""
Step 4 orchestrator parity tests — compare legacy llm_tool_runtime vs orchestrator.

Each scenario runs in both modes and asserts equivalent safe behavior:
payment gates, order privacy, no spoken URLs, and consistent tool/guard outcomes.
"""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any, Callable, Optional
from unittest.mock import AsyncMock, patch

import pytest

from app.agent_runtime.llm_tool_runtime import LLMToolRuntime, RUNTIME_MODE as LLM_MODE
from app.config import Settings
from app.orchestrator.planner_agent import build_plan
from app.orchestrator.runtime import RUNTIME_MODE as ORCH_MODE, get_orchestrator_runtime
from app.orchestrator.types import SupervisorResult
from app.orchestrator.intent_router import classify_intent_heuristic
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    base = dict(
        session_id="parity1",
        call_sid="CA_PARITY001",
        from_number="+15551234001",
        to_number="+15559994001",
    )
    base.update(kwargs)
    return SessionState(**base)


_ORCH_SETTINGS = Settings(OPENAI_API_KEY="", VOICE_ORCHESTRATOR_ENABLED=True)
_LEGACY_SETTINGS = Settings(OPENAI_API_KEY="sk-test-not-real", VOICE_ORCHESTRATOR_ENABLED=False)


@dataclass
class ParityExpectation:
    """Safety properties both runtimes must satisfy."""
    payment_blocked: bool = False
    privacy_clarification: bool = False
    tools_expected: list[str] = field(default_factory=list)
    response_not_empty: bool = True
    no_urls: bool = True
    intent: str = ""


@dataclass
class TurnOutcome:
    response_text: str
    tools_called: list[str]
    blocked: bool
    handler: str


async def _run_orchestrator(
    session: SessionState,
    text: str,
    *,
    turn_mode: str = "",
    dispatch_side_effect: Optional[Callable] = None,
) -> TurnOutcome:
    runtime = get_orchestrator_runtime(_ORCH_SETTINGS)
    sent: list[dict] = []
    tools_called: list[str] = []

    async def send(msg):
        sent.append(msg)

    async def fake_dispatch(name, args, sess):
        tools_called.append(name)
        return json.dumps(_default_tool_result(name, args))

    patch_target = "app.agent_runtime.llm_tools.dispatch"
    side = dispatch_side_effect or fake_dispatch

    with patch(patch_target, side_effect=side):
        result = await runtime.handle_turn(
            session, text, send, assembled_turn_mode=turn_mode,
        )

    return TurnOutcome(
        response_text=result.response_text or "",
        tools_called=tools_called,
        blocked="need" in (result.response_text or "").lower()
        or "verify" in (result.response_text or "").lower()
        or "confirm" in (result.response_text or "").lower(),
        handler=ORCH_MODE,
    )


async def _run_legacy(
    session: SessionState,
    text: str,
    *,
    scripted_tools: list[tuple[str, dict]] | None = None,
) -> TurnOutcome:
    from app.tests.test_v418_llm_tool_runtime import (
        _FakeChoice,
        _FakeClient,
        _FakeFunction,
        _FakeMessage,
        _FakeResponse,
        _FakeToolCall,
        _FakeSettings,
        _text_response,
        _tool_response,
    )

    scripted: list = []
    tools_called: list[str] = []

    if scripted_tools:
        for name, args in scripted_tools:
            scripted.append(_tool_response(name, args))
        scripted.append(_text_response("I've looked that up for you. What else can I help with?"))
    else:
        heuristic = classify_intent_heuristic(text, session)
        if heuristic.needs_tools and heuristic.intent == "product_search":
            scripted.append(_tool_response("search_products", {"query": text}))
            scripted.append(_text_response("I found that book. Would you like to add it to your cart?"))
        elif heuristic.clarifying_question:
            scripted.append(_text_response(heuristic.clarifying_question))
        else:
            scripted.append(_text_response("How can I help you today?"))

    runtime = LLMToolRuntime(settings=_FakeSettings())
    runtime._client = _FakeClient(scripted)
    sent: list[dict] = []

    async def send(msg):
        sent.append(msg)

    original_dispatch = None

    async def tracking_dispatch(name, args, sess):
        tools_called.append(name)
        from app.agent_runtime import llm_tools
        if original_dispatch is None:
            return json.dumps(_default_tool_result(name, args))
        return await original_dispatch(name, args, sess)

    with patch("app.agent_runtime.llm_tools.dispatch", side_effect=tracking_dispatch):
        from app.agent_runtime import llm_tools as lt
        nonlocal_original = lt.dispatch

        async def wrapped(name, args, sess):
            tools_called.append(name)
            return json.dumps(_default_tool_result(name, args))

        with patch.object(lt, "dispatch", side_effect=wrapped):
            result = await runtime.handle_turn(session, text, send)

    return TurnOutcome(
        response_text=result.response_text or "",
        tools_called=tools_called,
        blocked="verify" in (result.response_text or "").lower()
        or "security" in (result.response_text or "").lower(),
        handler=LLM_MODE,
    )


def _default_tool_result(tool: str, args: dict) -> dict:
    if tool == "search_products":
        return {"success": True, "products": [{"title": "Dune", "price": "$12.99"}]}
    if tool == "add_to_cart":
        return {"success": True, "message": "Added to your cart."}
    if tool == "get_cart":
        return {"success": True, "items": [{"title": "Dune", "quantity": 1}]}
    if tool == "create_checkout":
        return {"success": True, "checkout_url": "https://pay.example.com/x"}
    if tool == "send_payment_link":
        return {"success": True, "message": "Payment link sent to your email."}
    if tool == "lookup_order_status":
        return {"success": True, "status": "Shipped", "order_number": args.get("order_number", "")}
    if tool == "lookup_refund_status":
        return {"success": True, "refund_status": "Processing"}
    if tool == "facility_policy_lookup":
        return {"success": True, "approved": True, "facility": args.get("facility_name", "")}
    if tool == "shipping_policy_lookup":
        return {"success": True, "methods": ["Media Mail", "Priority Mail"]}
    return {"success": True}


def _assert_safe(outcome: TurnOutcome, exp: ParityExpectation, label: str) -> None:
    if exp.response_not_empty:
        assert outcome.response_text.strip(), f"{label}: empty response"
    if exp.no_urls:
        assert "http://" not in outcome.response_text.lower()
        assert "https://" not in outcome.response_text.lower()
    if exp.payment_blocked:
        assert outcome.blocked or not any(
            t in outcome.tools_called for t in ("send_payment_link", "create_checkout")
        ), f"{label}: payment should be blocked"
    if exp.privacy_clarification:
        assert outcome.blocked or "verify" in outcome.response_text.lower() or "email" in outcome.response_text.lower()
    for tool in exp.tools_expected:
        assert tool in outcome.tools_called, f"{label}: expected tool {tool}, got {outcome.tools_called}"


def _assert_parity(orch: TurnOutcome, legacy: TurnOutcome, exp: ParityExpectation) -> None:
    _assert_safe(orch, exp, "orchestrator")
    _assert_safe(legacy, exp, "legacy")
    if exp.payment_blocked:
        assert orch.blocked or not any(
            t in orch.tools_called for t in ("send_payment_link", "create_checkout")
        )
        assert not any(
            t in legacy.tools_called for t in ("send_payment_link", "create_checkout")
        ), "legacy must not execute payment tools when blocked"
    if exp.privacy_clarification:
        assert orch.blocked, "orchestrator must enforce privacy"
        assert legacy.blocked or "verify" in legacy.response_text.lower() or "security" in legacy.response_text.lower()


# ── 15 parity scenarios ───────────────────────────────────────────────────────

class TestParityISBNSearch:
    @pytest.mark.asyncio
    async def test_isbn_search(self):
        text = "9780441172719"
        session = _session()
        exp = ParityExpectation(tools_expected=["search_products"], intent="product_search")
        orch = await _run_orchestrator(session, text)
        legacy = await _run_legacy(_session(), text, scripted_tools=[("search_products", {"query": text})])
        _assert_parity(orch, legacy, exp)


class TestParityTitleSearch:
    @pytest.mark.asyncio
    async def test_title_search(self):
        text = "Do you have Dune by Frank Herbert?"
        exp = ParityExpectation(tools_expected=["search_products"])
        orch = await _run_orchestrator(_session(), text)
        legacy = await _run_legacy(_session(), text, scripted_tools=[("search_products", {"query": text})])
        _assert_parity(orch, legacy, exp)


class TestParityAddToCart:
    @pytest.mark.asyncio
    async def test_add_to_cart(self):
        text = "Add Dune to my cart"
        session = _session(last_selected_title="Dune", last_product_variant_id="v1")
        exp = ParityExpectation(intent="cart_update")
        orch = await _run_orchestrator(session, text)
        legacy = await _run_legacy(_session(last_selected_title="Dune"), text)
        _assert_safe(orch, exp, "orchestrator")
        _assert_safe(legacy, ParityExpectation(response_not_empty=True, no_urls=True), "legacy")


class TestParityCartConfirmation:
    @pytest.mark.asyncio
    async def test_cart_confirmation(self):
        text = "Yes that's correct"
        session = _session(
            payment_flow_status="awaiting_cart_confirmation",
            cart_items=[{"variant_id": "v1", "title": "Dune", "quantity": 1}],
        )
        orch = await _run_orchestrator(session, text)
        legacy = await _run_legacy(_session(payment_flow_status="awaiting_cart_confirmation"), text)
        exp = ParityExpectation(response_not_empty=True, no_urls=True)
        _assert_safe(orch, exp, "orchestrator")
        _assert_safe(legacy, exp, "legacy")


class TestParityEmailCapture:
    @pytest.mark.asyncio
    async def test_email_capture(self):
        text = "john@example.com"
        session = _session(payment_flow_status="awaiting_email")
        orch = await _run_orchestrator(session, text, turn_mode="email")
        legacy = await _run_legacy(_session(payment_flow_status="awaiting_email"), text)
        exp = ParityExpectation(no_urls=True, response_not_empty=True)
        _assert_safe(orch, exp, "orchestrator")
        _assert_safe(legacy, exp, "legacy")


class TestParityEmailCorrection:
    @pytest.mark.asyncio
    async def test_email_correction(self):
        text = "No, use jane@example.com instead"
        session = _session(
            awaiting_payment_email_confirmation=True,
            pending_payment_email="john@example.com",
        )
        orch = await _run_orchestrator(session, text)
        legacy = await _run_legacy(_session(awaiting_payment_email_confirmation=True), text)
        exp = ParityExpectation(no_urls=True, response_not_empty=True)
        _assert_safe(orch, exp, "orchestrator")
        _assert_safe(legacy, exp, "legacy")


class TestParityCreateCheckout:
    @pytest.mark.asyncio
    async def test_create_checkout_blocked_without_email(self):
        session = _session(
            payment_cart_confirmed=True,
            cart_items=[{"variant_id": "v1", "quantity": 1}],
            payment_email_confirmed=False,
        )
        supervisor = SupervisorResult(intent="checkout_payment", needs_planner=True)
        plan = build_plan(supervisor, "create checkout", session)
        assert plan.blocked is True
        orch = await _run_orchestrator(session, "send me the checkout link")
        legacy = await _run_legacy(_session(payment_cart_confirmed=True), "send me the checkout link")
        exp = ParityExpectation(payment_blocked=True, no_urls=True)
        _assert_parity(orch, legacy, exp)


class TestParitySendPaymentLink:
    @pytest.mark.asyncio
    async def test_send_payment_link_blocked_without_confirmed_cart(self):
        session = _session(
            payment_email_confirmed=True,
            email_verified=True,
            confirmed_email="test@example.com",
            payment_cart_confirmed=False,
        )
        orch = await _run_orchestrator(session, "send payment link please")
        legacy = await _run_legacy(session, "send payment link please")
        exp = ParityExpectation(payment_blocked=True, no_urls=True)
        _assert_parity(orch, legacy, exp)


class TestParityOrderLookupUnverified:
    @pytest.mark.asyncio
    async def test_order_lookup_unverified(self):
        text = "What books are in order 12345?"
        orch = await _run_orchestrator(_session(), text)
        legacy = await _run_legacy(_session(), text)
        exp = ParityExpectation(privacy_clarification=True, no_urls=True)
        _assert_parity(orch, legacy, exp)


class TestParityOrderLookupVerified:
    @pytest.mark.asyncio
    async def test_order_lookup_verified(self):
        text = "What is the status of order 12345"
        session = _session(confirmed_email="john@example.com", verified_email=True)
        exp = ParityExpectation(tools_expected=["lookup_order_status"], no_urls=True)
        orch = await _run_orchestrator(session, text)
        legacy = await _run_legacy(
            _session(confirmed_email="john@example.com", verified_email=True),
            text,
            scripted_tools=[("lookup_order_status", {"order_number": "12345"})],
        )
        _assert_safe(orch, exp, "orchestrator")
        _assert_safe(legacy, ParityExpectation(no_urls=True, response_not_empty=True), "legacy")


class TestParityRefundLookupVerified:
    @pytest.mark.asyncio
    async def test_refund_lookup_verified(self):
        text = "Refund status for order 5678"
        session = _session(confirmed_email="john@example.com", verified_email=True)
        exp = ParityExpectation(tools_expected=["lookup_refund_status"], no_urls=True)
        orch = await _run_orchestrator(session, text)
        legacy = await _run_legacy(
            _session(confirmed_email="john@example.com", verified_email=True),
            text,
            scripted_tools=[("lookup_refund_status", {"order_number": "5678"})],
        )
        _assert_safe(orch, exp, "orchestrator")
        _assert_safe(legacy, ParityExpectation(no_urls=True), "legacy")


class TestParityFacilityQuestion:
    @pytest.mark.asyncio
    async def test_facility_question(self):
        text = "Can you ship to FCI Coleman prison?"
        exp = ParityExpectation(tools_expected=["answer_facility_policy_question"], no_urls=True)
        orch = await _run_orchestrator(_session(), text)
        legacy = await _run_legacy(_session(), text,
                                   scripted_tools=[("answer_facility_policy_question", {"facility_name": "Coleman", "question": text})])
        _assert_safe(orch, exp, "orchestrator")
        _assert_safe(legacy, ParityExpectation(no_urls=True, response_not_empty=True), "legacy")


class TestParityShippingQuestion:
    @pytest.mark.asyncio
    async def test_shipping_question(self):
        text = "How much is Media Mail shipping?"
        exp = ParityExpectation(tools_expected=["shipping_policy_lookup"], no_urls=True)
        orch = await _run_orchestrator(_session(), text)
        legacy = await _run_legacy(_session(), text,
                                   scripted_tools=[("shipping_policy_lookup", {})])
        _assert_safe(orch, exp, "orchestrator")
        _assert_safe(legacy, ParityExpectation(no_urls=True, response_not_empty=True), "legacy")


class TestParityLongConversationMemory:
    @pytest.mark.asyncio
    async def test_long_conversation_memory(self):
        from app.memory.memory_manager import MemoryManager

        session = _session()
        for i in range(5):
            MemoryManager.record_turn(session, f"user turn {i}", f"assistant reply {i}")
        snap = MemoryManager.load(session)
        assert snap.turn_count >= 5
        orch = await _run_orchestrator(session, "What were we talking about?")
        legacy = await _run_legacy(_session(), "What were we talking about?")
        exp = ParityExpectation(response_not_empty=True, no_urls=True)
        _assert_safe(orch, exp, "orchestrator")
        _assert_safe(legacy, exp, "legacy")


class TestParityToolFailureFallback:
    @pytest.mark.asyncio
    async def test_tool_failure_fallback(self):
        async def failing_dispatch(name, args, sess):
            return json.dumps({"success": False, "error": "shopify unavailable"})

        orch = await _run_orchestrator(_session(), "9780441172719", dispatch_side_effect=failing_dispatch)
        assert orch.response_text
        assert "http" not in orch.response_text.lower()
        legacy = await _run_legacy(_session(), "9780441172719")
        assert legacy.response_text
        assert "http" not in legacy.response_text.lower()


class TestParitySupervisorSkipsLLMForObviousIntents:
    def test_heuristic_confidence_skips_planner_llm(self):
        result = classify_intent_heuristic("9780441172719", _session())
        assert result.confidence >= 0.92
        assert result.intent == "product_search"
        assert result.needs_planner is True
