"""v4.14.7 — Latest live newspaper regression tests."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("VOICE_AGENT_RUNTIME_MODE", "main_llm_agent")

from app.agent_runtime.business_intent_resolver import (
    ANSWER_GENERIC_REPEAT,
    context_aware_unknown_fallback,
    resolve_business_intent,
)
from app.agent_runtime.followup_context_resolver import resolve_followup_context
from app.agent_runtime.tool_answer_composer import _format_single_product, _not_found_message
from app.agent_runtime.tool_entity_extractor import extract_tool_entities
from app.config import get_settings


LIVE_PHRASES = [
    "Okay. I need a newspaper. Can you available?",
    "Can you give me newspaper?",
    "I need a newspaper, like USA Today 5 day delivery for 3 months.",
    "USA Today 5 day delivery for 3 months paper available.",
    "I can see newspaper in your, like, website.",
    "It's $149.99.",
]


class TestLatestNewspaperLiveRegression:
    def test_phrase_1_newspaper_not_book(self):
        biz = resolve_business_intent(LIVE_PHRASES[0])
        assert biz.matched
        assert "Which book" not in (biz.direct_answer or "")

    def test_phrase_2_newspaper_request(self):
        biz = resolve_business_intent(LIVE_PHRASES[1])
        assert biz.intent == "newspaper_request"
        assert ANSWER_GENERIC_REPEAT not in (biz.direct_answer or "")

    def test_phrase_3_newspaper_search(self):
        biz = resolve_business_intent(LIVE_PHRASES[2])
        assert biz.intent == "newspaper_search"
        assert biz.response_mode == "needs_tools"
        ents = extract_tool_entities(LIVE_PHRASES[2], decision={"tool_entities": biz.tool_entities})
        assert ents.get("publication_title") == "USA Today"

    def test_phrase_4_not_availability_followup(self):
        followup = resolve_followup_context(LIVE_PHRASES[3], sid="CAlive")
        assert not (
            followup.resolved
            and followup.intent == "product_availability_question"
            and "Which book" in (followup.direct_answer or "")
        )
        biz = resolve_business_intent(LIVE_PHRASES[3])
        assert biz.intent == "newspaper_search"

    def test_phrase_5_website_claim(self):
        biz = resolve_business_intent(LIVE_PHRASES[4])
        assert biz.intent != "unknown"
        answer = (biz.direct_answer or "").lower()
        assert "title" in answer or "newspaper" in answer or "store data" in answer

    def test_phrase_6_price_not_unknown(self):
        from app.state.models import SessionState

        state = SessionState(
            session_id="s1", call_sid="CAlive6", from_number="+1", to_number="+2",
        )
        state.dialogue.expected_next = "publication_title"
        fb = context_aware_unknown_fallback(LIVE_PHRASES[5], session_state=state, sid="CAlive6")
        assert ANSWER_GENERIC_REPEAT not in fb.get("direct_answer", "")

    def test_composer_says_newspaper(self):
        msg = _format_single_product({
            "title": "USA Today 5 Day",
            "price": "$149.99",
            "product_kind": "newspaper",
            "out_of_stock": False,
        })
        assert "newspaper" in msg.lower()
        assert "book" not in msg.lower()

    def test_not_found_clean_title(self):
        msg = _not_found_message({
            "publication_title": "USA Today 5 day delivery 3 months",
            "product_kind": "newspaper",
            "not_found": True,
        })
        assert "USA Today" in msg
        assert "a newspaper, like" not in msg

    def test_no_openai_live_tools(self):
        assert get_settings().VOICE_LIVE_DISABLE_OPENAI_TOOLS is True

    def test_no_legacy_runtime(self):
        assert get_settings().VOICE_AGENT_RUNTIME_MODE != "legacy_v410"
