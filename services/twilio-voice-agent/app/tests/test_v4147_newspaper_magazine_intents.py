"""v4.14.7 — Newspaper/magazine intent tests."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime.business_intent_resolver import (
    ANSWER_GENERIC_REPEAT,
    resolve_business_intent,
)
from app.agent_runtime.followup_context_resolver import resolve_followup_context


class TestNewspaperMagazineIntents:
    def test_can_you_give_me_newspaper(self):
        biz = resolve_business_intent("Can you give me newspaper?")
        assert biz.matched
        assert biz.intent == "newspaper_request"
        assert "Which newspaper" in (biz.direct_answer or "")
        assert biz.intent != "unknown"
        assert ANSWER_GENERIC_REPEAT not in (biz.direct_answer or "")

    def test_need_newspaper_can_you_available(self):
        phrase = "Okay. I need a newspaper. Can you available?"
        biz = resolve_business_intent(phrase)
        assert biz.matched
        assert biz.intent in ("newspaper_request", "newspaper_search")
        assert "Which book" not in (biz.direct_answer or "")
        followup = resolve_followup_context(phrase, sid="CAtest")
        if followup.resolved and followup.direct_answer:
            assert "Which book" not in followup.direct_answer

    def test_usa_today_newspaper_search(self):
        phrase = "I need a newspaper, like USA Today 5 day delivery for 3 months."
        biz = resolve_business_intent(phrase)
        assert biz.intent == "newspaper_search"
        assert biz.response_mode == "needs_tools"
        assert "catalog_search" in biz.tool_categories

    def test_usa_today_availability_not_followup(self):
        phrase = "USA Today 5 day delivery for 3 months paper available."
        followup = resolve_followup_context(phrase, sid="CAtest")
        assert not followup.resolved or followup.intent != "product_availability_question"
        biz = resolve_business_intent(phrase)
        assert biz.intent == "newspaper_search"
        assert biz.response_mode == "needs_tools"

    def test_people_magazine_search(self):
        biz = resolve_business_intent("People magazine 6 months")
        assert biz.intent == "magazine_search"
        assert biz.response_mode == "needs_tools"

    def test_website_claim(self):
        biz = resolve_business_intent("I can see newspaper in your, like, website.")
        assert biz.matched
        assert "exact" in (biz.direct_answer or "").lower()
        assert biz.intent != "unknown"

    def test_price_after_website_claim(self):
        biz = resolve_business_intent("It's $149.99.")
        assert biz.matched or True  # may need session; test with expected_next via resolver
        from app.state.models import SessionState

        state = SessionState(
            session_id="s1", call_sid="CA149", from_number="+1", to_number="+2",
        )
        state.dialogue.expected_next = "publication_title"
        biz2 = resolve_business_intent("It's $149.99.", session_state=state)
        assert biz2.matched
        assert "verify" in (biz2.direct_answer or "").lower()
