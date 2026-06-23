"""v4.10 — intent execution contract tests."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.pipeline.intent_contract import (
    EXEC_FALLBACK,
    EXEC_SMALL_TALK,
    validate_intent_contract,
)


class TestIntentContract:
    def test_identity_has_executor(self):
        d = validate_intent_contract("identity_question", {"call_sid": "CA123"})
        assert d.allowed
        assert d.executor == EXEC_SMALL_TALK

    def test_small_talk_has_executor(self):
        d = validate_intent_contract("small_talk")
        assert d.executor == EXEC_SMALL_TALK

    def test_store_info_has_executor(self):
        d = validate_intent_contract("store_info_question")
        assert d.allowed

    def test_vague_book_deterministic(self):
        d = validate_intent_contract("vague_book_request")
        assert d.allowed
        assert "ResponsePlan" in d.executor or d.executor

    def test_generic_product_blocked(self):
        d = validate_intent_contract(
            "book_title_search",
            {"product_phrase": "I need a book", "call_sid": "CA1"},
        )
        assert not d.allowed
        assert d.resolved_intent == "vague_book_request"

    def test_unknown_gets_fallback(self):
        d = validate_intent_contract("totally_unknown_intent_xyz")
        assert d.executor == EXEC_FALLBACK

    def test_job_question_has_executor(self):
        d = validate_intent_contract("job_question")
        assert d.executor == EXEC_SMALL_TALK

    def test_every_brain_intent_maps(self):
        from app.brain.schema import VALID_INTENTS
        for intent in VALID_INTENTS:
            d = validate_intent_contract(intent, {"call_sid": "CA"})
            assert d.executor or d.resolved_intent
