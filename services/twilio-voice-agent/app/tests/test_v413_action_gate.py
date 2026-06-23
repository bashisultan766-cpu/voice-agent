"""v4.13 — Action gate tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime.action_gate import evaluate_action_gate
from app.agent_runtime.types import SupervisorDecision


def _gate(text: str, intent: str = "product_search") -> dict:
    sup = SupervisorDecision(user_intent="book_search", confidence=0.9)
    return evaluate_action_gate(
        call_sid="CA413AG",
        caller_text=text,
        supervisor=sup,
        pipeline_intent=intent,
        router_hint=intent,
    ).to_dict()


class TestActionGate:
    def test_short_short_book_blocked(self):
        r = _gate("Your short short book.")
        assert r["allowed"] is False
        assert r["blocked_worker"] == "product_search"

    def test_social_book_assistant_blocked(self):
        r = _gate("You are not social book assistant.")
        assert r["allowed"] is False

    def test_sureshot_assistant_blocked(self):
        r = _gate("No. Are you SureShot Books assistant?")
        assert r["allowed"] is False
        assert r["safe_intent"] == "company_question"

    def test_i_need_a_book_no_search(self):
        r = _gate("I need a book.", intent="product_search")
        assert r["allowed"] is False

    def test_books_about_coffee_allowed(self):
        r = _gate("Do you have books about coffee")
        assert r["allowed"] is True

    def test_book_called_black_coffee_allowed(self):
        r = _gate("book called Black Coffee")
        assert r["allowed"] is True

    def test_valid_isbn_allowed(self):
        r = _gate("9780441172719", intent="isbn_search")
        assert r["allowed"] is True
        assert r["reason"] == "valid_isbn"

    def test_blocked_cannot_save_candidate(self):
        from app.cart.candidate_guard import should_save_candidate
        allowed, reason = should_save_candidate(
            "product_search",
            "You are not social book assistant.",
            action_gate_approved=False,
        )
        assert allowed is False
        assert reason == "action_gate_not_approved"
