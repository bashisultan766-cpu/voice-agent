"""v4.6 tests — SureShot domain brain."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.domain.faq import match_faq
from app.domain.policies import politics_redirect_message, sports_redirect_message
from app.domain.sureshot_brain import build_domain_excerpt, domain_answer_for_intent


class TestSureShotDomain:
    def test_store_name_without_shopify(self):
        answer = match_faq("what is your store name")
        assert answer and "SureShot" in answer

    def test_politics_redirect(self):
        answer = match_faq("can I buy books about politics")
        assert "look for books" in answer.lower()

    def test_sports_redirect(self):
        answer = match_faq("sports books")
        assert "look for books" in answer.lower()

    def test_inmate_facility_safe(self):
        answer = match_faq("do you sell books for inmates")
        assert answer and "inmate" in answer.lower() or "facility" in answer.lower()

    def test_no_political_debate_in_excerpt(self):
        excerpt = build_domain_excerpt(
            __import__("app.state.models", fromlist=["SessionState"]).SessionState(
                session_id="s", call_sid="CA", from_number="+1", to_number="+2",
            ),
            "what do you think about politics",
        )
        assert "debate" in excerpt.lower() or "look for books" in excerpt.lower()

    def test_domain_answer_store_info(self):
        ans = domain_answer_for_intent("store_info_question", "what company is this")
        assert ans and "SureShot" in ans

    def test_politics_redirect_message(self):
        assert "look for books" in politics_redirect_message().lower()

    def test_sports_redirect_message(self):
        assert "look for books" in sports_redirect_message().lower()
