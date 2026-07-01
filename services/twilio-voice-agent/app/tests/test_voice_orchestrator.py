"""VoiceOrchestrator — central turn planning inside voice_commerce_runtime."""
from __future__ import annotations

from app.runtime.fast_classifier import ClassificationResult
from app.runtime.voice_commerce_runtime import VoiceCommerceRuntime, VoiceOrchestrator
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    session = SessionState(
        session_id="orch",
        call_sid="CAorch123",
        from_number="+1",
        to_number="+2",
    )
    for key, value in kwargs.items():
        setattr(session, key, value)
    return session


def _runtime() -> VoiceCommerceRuntime:
    return VoiceCommerceRuntime(settings=type("S", (), {"OPENAI_API_KEY": "k"})())


def test_greeting_skips_llm():
    runtime = _runtime()
    orch = VoiceOrchestrator()
    plan = orch.plan_turn(runtime, _session(), "hello", "")
    assert plan.use_llm is False
    assert plan.fast_route == "classifier_instant"
    assert plan.plan_ms < 100


def test_awaiting_order_stage_skips_llm():
    runtime = _runtime()
    session = _session(
        voice_conversation={
            "stage": "awaiting_order_number",
            "last_intent": "order_lookup",
            "last_order_id": None,
        },
    )
    plan = VoiceOrchestrator().plan_turn(runtime, session, "sure", "")
    assert plan.use_llm is False
    assert plan.fast_route == "guided_awaiting"
    assert plan.reason == "stage_awaiting_order_number"


def test_product_search_classification_blocks_llm():
    runtime = _runtime()
    plan = VoiceOrchestrator().plan_turn(
        runtime, _session(), "I need Game of Thrones hardcover edition", "",
    )
    assert plan.use_llm is False
    assert plan.fast_route == "product_search_workflow"
    assert VoiceOrchestrator.allows_llm(plan) is False
    assert plan.classification is not None


def test_product_commerce_fsm_blocks_llm_after_classifier():
    runtime = _runtime()
    from app.agent_runtime.commerce_flow_state import STATUS_AWAITING_QUANTITY

    session = _session(
        commerce_flow_status=STATUS_AWAITING_QUANTITY,
        commerce_pending_candidate={"title": "Book", "variant_id": "v1"},
    )
    plan = VoiceOrchestrator().plan_turn(runtime, session, "I need two copies", "")
    assert plan.classification is not None
    assert plan.use_llm is False
    assert plan.fast_route == "product_commerce_fsm"


def test_instant_classification_blocks_llm():
    runtime = _runtime()
    plan = VoiceOrchestrator().plan_turn(runtime, _session(), "I'd like to check an order.", "")
    assert plan.use_llm is False
    assert plan.fast_route in ("classifier_instant", "order_collection")
    assert VoiceOrchestrator.allows_llm(plan) is False


def test_completed_stage_routes_without_llm():
    runtime = _runtime()
    session = _session(
        voice_conversation={
            "stage": "completed",
            "last_intent": "order_lookup",
            "last_order_id": "47980",
        },
        order_last_voice_reply="Order 47980 is paid and shipped.",
    )
    plan = VoiceOrchestrator().plan_turn(runtime, session, "okay", "")
    assert plan.use_llm is False
    assert plan.fast_route == "guided_completed"
