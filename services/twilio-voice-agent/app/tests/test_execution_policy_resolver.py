"""ExecutionPolicyResolver — single LLM routing authority."""
from __future__ import annotations

from app.agent_runtime.commerce_flow_state import STATUS_AWAITING_QUANTITY, stage_product_candidate
from app.agent_runtime.workflow_isolation import (
    PCS_AWAITING_QUANTITY,
    PCS_CART_BUILDING,
    sync_product_commerce_state,
)
from app.runtime.execution_policy_resolver import (
    EXECUTION_POLICY_DETERMINISTIC,
    EXECUTION_POLICY_LLM_ALLOWED,
    EXECUTION_POLICY_SHORT_CIRCUIT,
    build_execution_fsm_state,
    resolve_execution_policy,
)
from app.runtime.fast_classifier import (
    ClassificationResult,
    LOCK_LLM_BRAIN,
    apply_intent_lock,
)
from app.runtime.voice_commerce_runtime import VoiceCommerceRuntime, VoiceOrchestrator
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    base = dict(
        session_id="pol",
        call_sid="CApol123456",
        from_number="+1",
        to_number="+2",
    )
    base.update(kwargs)
    return SessionState(**base)


def test_awaiting_quantity_is_deterministic():
    session = _session(commerce_flow_status=STATUS_AWAITING_QUANTITY)
    stage_product_candidate(session, {
        "title": "Book",
        "variant_id": "v1",
        "price": "$10",
        "available": True,
    })
    sync_product_commerce_state(session, "two copies", turn_mode="")
    fsm = build_execution_fsm_state(session, voice_stage="idle")
    policy = resolve_execution_policy(session, None, fsm)
    assert policy == EXECUTION_POLICY_DETERMINISTIC
    assert fsm.product_commerce_status == PCS_AWAITING_QUANTITY


def test_payment_flow_is_deterministic():
    session = _session(
        payment_flow_status="awaiting_email",
        awaiting_payment_email=True,
    )
    fsm = build_execution_fsm_state(session, turn_mode="email")
    policy = resolve_execution_policy(session, None, fsm)
    assert policy == EXECUTION_POLICY_DETERMINISTIC


def test_order_awaiting_number_is_deterministic():
    session = _session()
    session.order_flow_status = "awaiting_order_number"
    fsm = build_execution_fsm_state(session, voice_stage="awaiting_order_number")
    policy = resolve_execution_policy(session, None, fsm)
    assert policy == EXECUTION_POLICY_DETERMINISTIC


def test_product_intent_is_short_circuit_not_llm():
    session = _session()
    fsm = build_execution_fsm_state(session)
    clf = apply_intent_lock(ClassificationResult(
        action="instant",
        is_product_search=True,
        product_intent_detected=True,
        skip_llm=True,
        skip_brain=True,
    ))
    policy = resolve_execution_policy(session, clf, fsm)
    assert policy == EXECUTION_POLICY_SHORT_CIRCUIT


def test_brain_gate_blocks_llm():
    session = _session(
        commerce_flow_status="awaiting_book_confirm",
        commerce_pending_candidate={"title": "Book", "variant_id": "v1"},
        commerce_last_voice_reply="I found Book. How many copies?",
    )
    sync_product_commerce_state(session, "what did you say", turn_mode="")
    fsm = build_execution_fsm_state(
        session,
        brain_gate_active=True,
    )
    clf = apply_intent_lock(ClassificationResult(action="brain"))
    policy = resolve_execution_policy(session, clf, fsm)
    assert policy == EXECUTION_POLICY_SHORT_CIRCUIT


def test_llm_allowed_when_idle_and_brain_locked():
    session = _session()
    fsm = build_execution_fsm_state(session)
    clf = apply_intent_lock(ClassificationResult(
        action="brain",
        reason="general_question",
    ))
    assert clf.locked_workflow == LOCK_LLM_BRAIN
    policy = resolve_execution_policy(session, clf, fsm)
    assert policy == EXECUTION_POLICY_LLM_ALLOWED


def test_low_confidence_classifier_short_circuits():
    session = _session()
    fsm = build_execution_fsm_state(session)
    clf = apply_intent_lock(ClassificationResult(
        action="brain",
        metadata={"confidence": 0.2},
    ))
    policy = resolve_execution_policy(session, clf, fsm)
    assert policy == EXECUTION_POLICY_SHORT_CIRCUIT


def test_orchestrator_plan_uses_resolver_for_quantity():
    runtime = VoiceCommerceRuntime(settings=type("S", (), {"OPENAI_API_KEY": "k"})())
    session = _session(
        commerce_flow_status=STATUS_AWAITING_QUANTITY,
        commerce_pending_candidate={"title": "Book", "variant_id": "v1"},
    )
    sync_product_commerce_state(session, "two copies", turn_mode="")
    plan = VoiceOrchestrator().plan_turn(runtime, session, "two copies", "")
    assert plan.execution_policy == EXECUTION_POLICY_DETERMINISTIC
    assert plan.use_llm is False
    assert plan.fast_route == "product_commerce_fsm"


def test_orchestrator_discovery_short_circuits_not_llm():
    runtime = VoiceCommerceRuntime(settings=type("S", (), {"OPENAI_API_KEY": "k"})())
    session = _session()
    plan = VoiceOrchestrator().plan_turn(
        runtime, session, "9780747532699", "isbn",
    )
    assert plan.execution_policy in (
        EXECUTION_POLICY_SHORT_CIRCUIT,
        EXECUTION_POLICY_DETERMINISTIC,
    )
    assert plan.use_llm is False
    assert plan.fast_route == "product_search_workflow"


def test_cart_building_is_deterministic():
    session = _session(
        commerce_flow_status="awaiting_add_confirm",
        commerce_pending_candidate={"title": "Book", "variant_id": "v1"},
    )
    sync_product_commerce_state(session, "yes", turn_mode="")
    fsm = build_execution_fsm_state(session)
    assert fsm.product_commerce_status == PCS_CART_BUILDING
    policy = resolve_execution_policy(session, None, fsm)
    assert policy == EXECUTION_POLICY_DETERMINISTIC
