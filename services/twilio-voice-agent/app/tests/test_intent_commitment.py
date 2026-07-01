"""IntentCommitmentLayer — single semantic interpretation per user turn."""
from __future__ import annotations

from unittest.mock import patch

import pytest

from app.runtime.execution_policy_resolver import ExecutionFsmState
from app.runtime.fast_classifier import (
    ClassificationResult,
    LOCK_PRODUCT_SEARCH_WORKFLOW,
    apply_intent_lock,
)
from app.runtime.voice_commerce_runtime import (
    Intent,
    classify_turn_once,
    clear_committed_intent,
    commit_intent,
    enforce_committed_intent_on_classification,
    get_committed_classification,
    is_intent_committed,
    reset_committed_intent_on_interrupt,
    resolve_turn_classification,
)
from app.state.models import SessionState


def _session() -> SessionState:
    return SessionState(
        session_id="intent",
        call_sid="CAintent1",
        from_number="+1",
        to_number="+2",
    )


def _fsm() -> ExecutionFsmState:
    return ExecutionFsmState(product_commerce_status="idle")


def test_commit_intent_once_per_turn():
    session = _session()
    clf = apply_intent_lock(ClassificationResult(
        locked_workflow=LOCK_PRODUCT_SEARCH_WORKFLOW,
        is_product_search=True,
    ))
    first = commit_intent(
        session, clf, _fsm(),
        execution_policy="short_circuit",
        turn_text="find a book",
    )
    second = commit_intent(session, clf, _fsm(), execution_policy="llm_allowed")
    assert first is second
    assert is_intent_committed(session)


def test_clear_on_new_turn_and_interrupt():
    session = _session()
    commit_intent(session, ClassificationResult(), _fsm())
    clear_committed_intent(session, reason="new_user_turn")
    assert not is_intent_committed(session)

    commit_intent(session, ClassificationResult(), _fsm())
    reset_committed_intent_on_interrupt(session)
    assert not is_intent_committed(session)


def test_resolve_turn_classification_skips_reclassify_when_committed():
    session = _session()
    committed_clf = apply_intent_lock(ClassificationResult(
        locked_workflow=LOCK_PRODUCT_SEARCH_WORKFLOW,
        is_product_search=True,
    ))
    commit_intent(session, committed_clf, _fsm(), turn_text="book title")

    with patch("app.runtime.voice_commerce_runtime.classify") as mock_classify:
        result = resolve_turn_classification(session, "different text")
        mock_classify.assert_not_called()

    assert result.locked_workflow == LOCK_PRODUCT_SEARCH_WORKFLOW


def test_enforce_committed_blocks_classification_drift():
    session = _session()
    commit_intent(
        session,
        ClassificationResult(
            locked_workflow=LOCK_PRODUCT_SEARCH_WORKFLOW,
            skip_llm=True,
            is_product_search=True,
        ),
        _fsm(),
    )
    drifted = ClassificationResult(locked_workflow="llm_brain", skip_llm=False)
    enforced = enforce_committed_intent_on_classification(session, drifted)
    assert enforced.locked_workflow == LOCK_PRODUCT_SEARCH_WORKFLOW
    assert enforced.skip_llm is True


def test_classify_turn_once_runs_only_once_per_turn():
    session = _session()
    with patch("app.runtime.voice_commerce_runtime.classify") as mock_classify:
        mock_classify.return_value = ClassificationResult(action="brain")
        first = classify_turn_once(session, "find a book", source="test")
        second = classify_turn_once(session, "other text", source="test_retry")
        mock_classify.assert_called_once()
    assert first is second or first.locked_workflow == second.locked_workflow


def test_resolve_turn_classification_logs_guard_when_committed():
    session = _session()
    commit_intent(
        session,
        ClassificationResult(locked_workflow=LOCK_PRODUCT_SEARCH_WORKFLOW),
        _fsm(),
    )
    with patch("app.runtime.voice_commerce_runtime.logger") as mock_log:
        resolve_turn_classification(session, "new words", source="test_guard")
        mock_log.info.assert_called()
        assert "intent_reuse_guard_triggered" in str(mock_log.info.call_args)


def test_get_committed_classification_round_trip():
    session = _session()
    intent = commit_intent(
        session,
        ClassificationResult(action="brain", reason="test"),
        _fsm(),
        active_workflow="product",
    )
    assert isinstance(intent, Intent)
    clf = get_committed_classification(session)
    assert clf is not None
    assert clf.action == "brain"
    assert clf.reason == "test"
