"""v4.13 — Candidate guard hardening tests."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.cart.candidate_guard import should_save_candidate


class TestCandidateGuardV413:
    def test_blocks_identity_phrases(self):
        cases = [
            "Your short short book.",
            "You are not social book assistant.",
            "No. Are you SureShot Books assistant?",
            "ShowShort Books",
            "social book assistant",
            "what is your job",
            "why are you not responding",
        ]
        for q in cases:
            allowed, _ = should_save_candidate("product_search", q)
            assert allowed is False, q

    def test_requires_action_gate_approved(self):
        allowed, reason = should_save_candidate(
            "book_title_search",
            "book called Dune",
            action_gate_approved=False,
        )
        assert allowed is False
        assert reason == "action_gate_not_approved"

    def test_valid_isbn_still_allowed(self):
        allowed, reason = should_save_candidate(
            "isbn_search",
            "9780441172719",
            is_isbn=True,
            variant_id="12345",
            action_gate_approved=True,
        )
        assert allowed is True

    def test_explicit_title_allowed(self):
        allowed, _ = should_save_candidate(
            "explicit_title_search",
            "book called Black Coffee",
            action_gate_approved=True,
        )
        assert allowed is True
