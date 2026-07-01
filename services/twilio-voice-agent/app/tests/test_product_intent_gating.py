"""Strict deterministic product intent gating."""
from __future__ import annotations

from app.runtime.fast_classifier import (
    classify,
    product_intent_detected,
)
from app.state.models import SessionState


def _session() -> SessionState:
    return SessionState(
        session_id="intent",
        call_sid="CA_INTENT",
        from_number="+1",
        to_number="+2",
    )


def test_product_intent_isbn():
    assert product_intent_detected("9780747532699")


def test_product_intent_book_keyword():
    assert product_intent_detected("I need a novel about war")


def test_product_intent_title_keyword():
    assert product_intent_detected("title Game of Thrones")


def test_product_intent_long_numeric():
    assert product_intent_detected("identifier 1234567890")


def test_order_number_not_product_intent():
    assert not product_intent_detected("check order 39667")


def test_classifier_sets_skip_brain_for_product():
    result = classify("I need Game of Thrones hardcover", _session())
    assert result.is_product_search
    assert result.skip_brain
    assert result.skip_llm
    assert result.product_intent_detected


def test_uncertain_book_defaults_to_product_search_not_brain():
    result = classify("I want a book", _session())
    assert result.is_product_search
    assert result.skip_brain
    assert result.locked_workflow == "product_search_workflow"
    assert result.intent_lock is True


def test_order_intent_locks_order_workflow():
    result = classify("where is my order 12345", _session())
    assert result.intent_lock is True
    assert result.locked_workflow == "order_workflow"
    assert result.is_order_lookup


def test_generic_query_locks_llm_brain():
    result = classify("what are your store hours", _session())
    assert result.intent_lock is True
    assert result.locked_workflow == "llm_brain"
    assert result.action == "brain"
