"""ProductCommerceState FSM inside workflow_isolation."""
from __future__ import annotations

from app.agent_runtime.commerce_flow_state import (
    STATUS_AWAITING_QUANTITY,
    stage_product_candidate,
)
from app.agent_runtime.workflow_isolation import (
    PCS_AWAITING_QUANTITY,
    PCS_CART_BUILDING,
    PCS_CART_CONFIRMED,
    PCS_DISCOVERY,
    PCS_IDLE,
    PCS_PAYMENT_READY,
    PCS_PRODUCT_SELECTED,
    derive_product_commerce_status,
    product_commerce_blocks_llm,
    product_commerce_status,
    sync_product_commerce_state,
)
from app.runtime.voice_commerce_runtime import VoiceCommerceRuntime, VoiceOrchestrator
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    session = SessionState(
        session_id="pcs",
        call_sid="CApcs123456",
        from_number="+1",
        to_number="+2",
    )
    for key, value in kwargs.items():
        setattr(session, key, value)
    return session


def test_discovery_from_product_intent():
    session = _session()
    status = sync_product_commerce_state(session, "I need Game of Thrones", turn_mode="")
    assert status == PCS_DISCOVERY
    assert product_commerce_status(session) == PCS_DISCOVERY


def test_awaiting_quantity_derived_from_commerce_status():
    session = _session(commerce_flow_status=STATUS_AWAITING_QUANTITY)
    stage_product_candidate(session, {
        "title": "Atomic Habits",
        "variant_id": "v1",
        "price": "$12",
        "available": True,
    })
    status = sync_product_commerce_state(session, "two copies", turn_mode="")
    assert status == PCS_AWAITING_QUANTITY
    assert product_commerce_blocks_llm(session)


def test_cart_building_blocks_llm():
    session = _session(
        commerce_flow_status="awaiting_add_confirm",
        commerce_pending_candidate={"title": "Book", "variant_id": "v1"},
    )
    sync_product_commerce_state(session, "yes", turn_mode="")
    assert product_commerce_status(session) == PCS_CART_BUILDING
    assert product_commerce_blocks_llm(session)


def test_payment_ready_from_email_collection():
    from app.cart.session import add_product_candidate, confirm_last_candidate

    session = _session(
        commerce_flow_status="awaiting_email_collection",
        payment_flow_status="awaiting_email",
        awaiting_payment_email=True,
    )
    add_product_candidate(
        session,
        title="Atomic Habits",
        isbn="9780747532699",
        variant_id="v1",
        price="12.00",
        available=True,
        quantity=1,
    )
    confirm_last_candidate(session)
    status = sync_product_commerce_state(session, "john at gmail dot com", turn_mode="email")
    assert status == PCS_PAYMENT_READY


def test_order_flow_does_not_set_product_commerce():
    session = _session(order_flow_status="awaiting_order_number")
    status = sync_product_commerce_state(session, "check my order", turn_mode="")
    assert status == PCS_IDLE


def test_orchestrator_quantity_stage_classifies_then_blocks_llm():
    runtime = VoiceCommerceRuntime(settings=type("S", (), {"OPENAI_API_KEY": "k"})())
    session = _session(
        commerce_flow_status=STATUS_AWAITING_QUANTITY,
        commerce_pending_candidate={"title": "Book", "variant_id": "v1"},
    )
    sync_product_commerce_state(session, "two copies", turn_mode="")
    plan = VoiceOrchestrator().plan_turn(runtime, session, "two copies", "")
    assert plan.classification is not None
    assert plan.use_llm is False
    assert plan.fast_route == "product_commerce_fsm"
    assert plan.reason == f"product_commerce_{PCS_AWAITING_QUANTITY}"


def test_orchestrator_discovery_routes_product_search_not_llm():
    runtime = VoiceCommerceRuntime(settings=type("S", (), {"OPENAI_API_KEY": "k"})())
    session = _session()
    plan = VoiceOrchestrator().plan_turn(
        runtime, session, "9780747532699", "isbn",
    )
    assert plan.use_llm is False
    assert plan.fast_route == "product_search_workflow"
    assert plan.classification is not None
    assert plan.classification.product_intent_detected


def test_voice_conversation_syncs_product_commerce_stage():
    runtime = VoiceCommerceRuntime(settings=type("S", (), {"OPENAI_API_KEY": "k"})())
    session = _session(
        commerce_flow_status=STATUS_AWAITING_QUANTITY,
        commerce_pending_candidate={"title": "Book", "variant_id": "v1"},
    )
    runtime._sync_voice_conversation_state(session, "two", turn_mode="")
    assert session.voice_conversation["stage"] == PCS_AWAITING_QUANTITY
    assert session.voice_conversation["last_intent"] == "product_commerce"
