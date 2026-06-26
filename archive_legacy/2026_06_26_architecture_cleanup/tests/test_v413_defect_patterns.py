"""v4.13 — Defect pattern guard tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime.defect_pattern_guard import match_defect_pattern


@pytest.fixture(autouse=True)
def _clear_defect_cache():
    from app.agent_runtime.defect_pattern_guard import clear_defect_pattern_cache
    clear_defect_pattern_cache()
    yield
    clear_defect_pattern_cache()
    def test_latest_bad_patterns(self):
        cases = {
            "Your short short book.": "company_identity",
            "showshort books": "company_identity",
            "social book assistant": "company_identity",
            "You are not social book assistant.": "frustration_or_identity",
            "Are you SureShot book assistant?": "company_identity",
            "your what": "repeat_clarification",
            "what you say": "repeat_clarification",
            "why are you not responding": "repair_mode",
            "what the hell": "frustration_repair",
        }
        for text, expected in cases.items():
            m = match_defect_pattern(text)
            assert m is not None, text
            assert m.classification == expected, f"{text} -> {m.classification}"

    def test_no_false_positive_explicit_book_called(self):
        m = match_defect_pattern("book called Black Coffee")
        assert m is None
