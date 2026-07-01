"""ConversationReplayEngine — deterministic replay from observability tapes."""
from __future__ import annotations

from unittest.mock import patch

import pytest

from app.agent_runtime.workflow_isolation import PCS_DISCOVERY, PCS_IDLE
from app.runtime.conversation_replay_codec import (
    capture_session_replay_snapshot,
    graph_from_dict,
    graph_to_dict,
)
from app.runtime.conversation_replay_engine import (
    ConversationReplayEngine,
    log_conversation_replay_report,
)
from app.runtime.conversation_replay_tape import (
    ConversationReplayTape,
    TurnObservabilityRecord,
    clear_replay_tape,
    register_replay_tape,
)
from app.runtime.conversation_state_graph import derive_conversation_state_graph
from app.runtime.conversation_state_graph_diff import diff_conversation_state_graph
from app.runtime.execution_policy_resolver import (
    EXECUTION_POLICY_SHORT_CIRCUIT,
    build_execution_fsm_state,
    resolve_execution_policy,
)
from app.runtime.execution_contract_versioning import (
    compare_execution_contracts,
    contract_to_dict,
    current_execution_contract,
)
from app.runtime.fast_classifier import (
    LOCK_PRODUCT_SEARCH_WORKFLOW,
    ClassificationResult,
)
from app.runtime.voice_commerce_runtime import commit_intent
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    session = SessionState(
        session_id="replay-sess",
        call_sid="CAreplay1",
        from_number="+1",
        to_number="+2",
    )
    for key, value in kwargs.items():
        setattr(session, key, value)
    return session


def _build_turn_record(
    session: SessionState,
    *,
    turn_index: int,
    caller_text: str,
    classification: ClassificationResult,
    execution_policy: str,
    active_workflow: str = "product",
    voice_stage: str = "idle",
    workflow_llm_blocked: bool = True,
    prev_graph=None,
) -> TurnObservabilityRecord:
    commit_intent(
        session,
        classification,
        build_execution_fsm_state(session, active_workflow=active_workflow),
        active_workflow=active_workflow,
        execution_policy=execution_policy,
        turn_text=caller_text,
    )
    graph = derive_conversation_state_graph(
        session,
        caller_text=caller_text,
        active_workflow=active_workflow,
        execution_policy=execution_policy,
        voice_stage=voice_stage,
        workflow_llm_blocked=workflow_llm_blocked,
    )
    diff = (
        diff_conversation_state_graph(prev_graph, graph)
        if prev_graph is not None
        else None
    )
    return TurnObservabilityRecord(
        turn_index=turn_index,
        turn_id=str(turn_index),
        caller_text=caller_text,
        turn_mode="",
        classification={
            "action": classification.action,
            "reason": classification.reason,
            "skip_llm": classification.skip_llm,
            "skip_brain": classification.skip_brain,
            "is_product_search": classification.is_product_search,
            "product_intent_detected": classification.product_intent_detected,
            "locked_workflow": classification.locked_workflow,
            "intent_lock": classification.intent_lock,
            "metadata": {},
        },
        execution_policy=execution_policy,
        active_workflow=active_workflow,
        voice_stage=voice_stage,
        workflow_llm_blocked=workflow_llm_blocked,
        state_graph=graph_to_dict(graph),
        state_graph_diff=diff.to_log_dict() if diff is not None else None,
        session_snapshot=capture_session_replay_snapshot(session),
        execution_contract=contract_to_dict(
            graph.execution_contract or current_execution_contract(),
        ),
    )


def _register_two_turn_tape() -> ConversationReplayTape:
    clear_replay_tape("replay-sess")

    session0 = _session(turn_count=1, product_commerce_status=PCS_IDLE)
    clf0 = ClassificationResult(
        action="brain",
        locked_workflow=LOCK_PRODUCT_SEARCH_WORKFLOW,
        is_product_search=True,
        skip_llm=True,
    )
    turn0 = _build_turn_record(
        session0,
        turn_index=0,
        caller_text="find a book",
        classification=clf0,
        execution_policy=EXECUTION_POLICY_SHORT_CIRCUIT,
    )

    session1 = _session(
        turn_count=2,
        product_commerce_status=PCS_DISCOVERY,
        commerce_flow_status="awaiting_book_confirm",
    )
    clf1 = ClassificationResult(
        action="brain",
        locked_workflow=LOCK_PRODUCT_SEARCH_WORKFLOW,
        is_product_search=True,
        skip_llm=True,
    )
    turn1 = _build_turn_record(
        session1,
        turn_index=1,
        caller_text="1984 george orwell",
        classification=clf1,
        execution_policy=EXECUTION_POLICY_SHORT_CIRCUIT,
        prev_graph=graph_from_dict(turn0.state_graph),
    )

    tape = ConversationReplayTape(
        session_id="replay-sess",
        turns=[turn0, turn1],
    )
    register_replay_tape(tape)
    return tape


@pytest.fixture(autouse=True)
def _cleanup_tape():
    yield
    clear_replay_tape("replay-sess")


def test_replay_turn_reconstructs_graph_and_policy():
    _register_two_turn_tape()
    engine = ConversationReplayEngine()

    result = engine.replay_turn("replay-sess", 1)

    assert result.turn_index == 1
    assert result.reconstructed_policy == EXECUTION_POLICY_SHORT_CIRCUIT
    assert not result.has_mismatch
    assert result.classification.locked_workflow == LOCK_PRODUCT_SEARCH_WORKFLOW


def test_replay_session_returns_all_turns():
    tape = _register_two_turn_tape()
    engine = ConversationReplayEngine()

    result = engine.replay_session("replay-sess")

    assert result.session_id == "replay-sess"
    assert len(result.turn_results) == len(tape.turns)
    assert result.deterministic is True


def test_validate_determinism_passes_for_recorded_tape():
    _register_two_turn_tape()
    engine = ConversationReplayEngine()

    report = engine.validate_determinism("replay-sess")

    assert report.deterministic is True
    assert report.behavioral_determinism is True
    assert report.contract_compatibility is True
    assert report.mismatch_count == 0
    assert report.contract_drift_count == 0
    assert report.turn_count == 2


def test_validate_determinism_detects_graph_divergence():
    tape = _register_two_turn_tape()
    graph = dict(tape.turns[1].state_graph)
    graph["product_commerce"] = dict(graph["product_commerce"])
    graph["product_commerce"]["status"] = "corrupted"
    corrupted = TurnObservabilityRecord(
        turn_index=tape.turns[1].turn_index,
        turn_id=tape.turns[1].turn_id,
        caller_text=tape.turns[1].caller_text,
        turn_mode=tape.turns[1].turn_mode,
        classification=tape.turns[1].classification,
        execution_policy=tape.turns[1].execution_policy,
        active_workflow=tape.turns[1].active_workflow,
        voice_stage=tape.turns[1].voice_stage,
        workflow_llm_blocked=tape.turns[1].workflow_llm_blocked,
        state_graph=graph,
        state_graph_diff=tape.turns[1].state_graph_diff,
        session_snapshot=dict(tape.turns[1].session_snapshot),
    )
    register_replay_tape(
        ConversationReplayTape(session_id="replay-sess", turns=[tape.turns[0], corrupted]),
    )

    report = ConversationReplayEngine().validate_determinism("replay-sess")

    assert report.deterministic is False
    assert report.mismatch_count >= 1
    assert any(m.category == "state_graph" for m in report.mismatches)


def test_replay_never_calls_live_classifier():
    _register_two_turn_tape()
    engine = ConversationReplayEngine()

    with patch("app.runtime.fast_classifier.classify") as mock_classify:
        engine.replay_session("replay-sess")
        mock_classify.assert_not_called()


def test_reconstructed_execution_policy_matches_resolver():
    session = _session(
        product_commerce_status=PCS_DISCOVERY,
        payment_flow_status="idle",
    )
    clf = ClassificationResult(
        locked_workflow=LOCK_PRODUCT_SEARCH_WORKFLOW,
        skip_llm=True,
        is_product_search=True,
    )
    fsm = build_execution_fsm_state(
        session, active_workflow="product", workflow_llm_blocked=True,
    )
    expected = resolve_execution_policy(session, clf, fsm)

    record = _build_turn_record(
        session,
        turn_index=0,
        caller_text="book",
        classification=clf,
        execution_policy=expected,
        workflow_llm_blocked=True,
    )
    register_replay_tape(
        ConversationReplayTape(session_id="replay-sess", turns=[record]),
    )

    result = ConversationReplayEngine().replay_turn("replay-sess", 0)
    assert result.reconstructed_policy == expected


def test_log_conversation_replay_report_emits_line():
    _register_two_turn_tape()
    report = ConversationReplayEngine().validate_determinism("replay-sess")

    with patch("app.runtime.conversation_replay_engine.logger") as mock_log:
        log_conversation_replay_report(report)
        mock_log.info.assert_called_once()
        assert "conversation_replay_report" in str(mock_log.info.call_args)
