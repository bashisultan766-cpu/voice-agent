"""v4.14.2 — BrandAliasNormalizer STT corruption recovery."""
from __future__ import annotations

import pytest

from app.agent_runtime.brand_alias_normalizer import normalize_brand_aliases


class TestBrandAliasNormalizer:
    @pytest.mark.parametrize(
        "text,expected_intent,expected_canonical_fragment",
        [
            (
                "What is your Shorkshire books?",
                "company_question",
                "What is SureShot Books?",
            ),
            (
                "Are you show short book assistant?",
                "assistant_identity",
                "SureShot Books assistant",
            ),
            (
                "I'm saying you are a brochure book assistant.",
                "assistant_identity",
                "SureShot Books assistant",
            ),
            (
                "Or you are short short books?",
                "company_question",
                "SureShot Books",
            ),
        ],
    )
    def test_stt_corruption_normalization(
        self, text, expected_intent, expected_canonical_fragment
    ):
        result = normalize_brand_aliases(text)
        assert result.matched is True
        assert result.confidence >= 0.85
        assert result.likely_intent == expected_intent
        assert expected_canonical_fragment in result.canonical_text
        assert len(result.aliases_found) >= 1

    def test_no_match_for_unrelated_text(self):
        result = normalize_brand_aliases("What time is it?")
        assert result.matched is False
        assert result.likely_intent == "unknown"

    def test_sureshot_exact_match(self):
        result = normalize_brand_aliases("What is SureShot Books?")
        assert result.matched is True
        assert result.likely_intent == "company_question"
