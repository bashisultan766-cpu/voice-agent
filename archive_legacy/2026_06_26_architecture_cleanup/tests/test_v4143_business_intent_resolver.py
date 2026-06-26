"""v4.14.3 — BusinessIntentResolver unit tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")


@pytest.fixture
def resolver():
    from app.agent_runtime import business_intent_resolver as bir
    return bir


class TestBusinessIntentResolver:
    def test_job_question_stt_noise(self, resolver):
        result = resolver.resolve_business_intent("So my what is your job?")
        assert result.matched
        assert result.intent == "job_question"
        assert "My job is to help you as the SureShot Books assistant" in (result.direct_answer or "")

    def test_job_question_exact(self, resolver):
        result = resolver.resolve_business_intent("What is your job?")
        assert result.matched
        assert result.intent == "job_question"
        assert result.direct_answer == resolver.ANSWER_JOB
        assert result.tool_categories == []

    def test_vague_book_request(self, resolver):
        result = resolver.resolve_business_intent("So I need a a book")
        assert result.matched
        assert result.intent == "vague_book_request"
        assert "ISBN" in (result.direct_answer or "")
        assert result.expected_next == "book_identifier"
        assert result.tool_categories == []

    def test_can_you_give_me_the_book(self, resolver):
        result = resolver.resolve_business_intent("Can you give me the book?")
        assert result.matched
        assert result.intent == "vague_book_request"
        assert "ISBN" in (result.direct_answer or "")

    def test_title_collection_start(self, resolver):
        result = resolver.resolve_business_intent("The title name is")
        assert result.matched
        assert result.intent == "title_collection_start"
        assert result.direct_answer == "Go ahead. Please say the full title."
        assert result.expected_next == "book_title"

    def test_isbn_collection_start(self, resolver):
        result = resolver.resolve_business_intent("Can I give you the ISBN number?")
        assert result.matched
        assert result.intent == "isbn_collection_start"
        assert result.direct_answer == "Yes, please say the ISBN number."
        assert result.expected_next == "isbn_number"

    def test_isbn_collection_start_long(self, resolver):
        result = resolver.resolve_business_intent("Can I give you the ISBN number of the book?")
        assert result.matched
        assert result.intent == "isbn_collection_start"
        assert result.direct_answer == "Yes, please say the ISBN number."

    def test_isbn_permission_find_promise(self, resolver):
        text = (
            "I'm asking that can I give you the ISBN number of book "
            "and then you find for me?"
        )
        result = resolver.resolve_business_intent(text)
        assert result.matched
        assert result.intent == "isbn_collection_start"
        assert "ISBN" in (result.direct_answer or "")
        assert "look it up" in (result.direct_answer or "").lower()
        assert result.tool_categories == []

    def test_isbn_lookup(self, resolver):
        result = resolver.resolve_business_intent("ISBN is 9780441172719")
        assert result.matched
        assert result.intent == "isbn_lookup"
        assert result.response_mode == "needs_tools"
        assert "isbn_lookup" in result.tool_categories
        assert result.tool_entities.get("isbn") == "9780441172719"

    def test_title_search(self, resolver):
        result = resolver.resolve_business_intent("The title is Game of Thrones")
        assert result.matched
        assert result.intent == "book_title_search"
        assert result.response_mode == "needs_tools"
        assert result.tool_categories == ["catalog_search"]
        assert result.search_query == "Game of Thrones"

    def test_books_about_cricket(self, resolver):
        result = resolver.resolve_business_intent("Do you have books about cricket?")
        assert result.matched
        assert result.response_mode == "needs_tools"
        assert "catalog_search" in result.tool_categories

    def test_off_domain_cricket_match(self, resolver):
        result = resolver.resolve_business_intent("Can you give me cricket match information?")
        assert result.matched
        assert result.intent == "off_domain"
        assert result.response_mode == "direct_answer"
        assert result.tool_categories == []
        assert "I mainly help with SureShot Books" in (result.direct_answer or "")
        assert "didn't understand" not in (result.direct_answer or "").lower()

    def test_off_domain_apple_juice(self, resolver):
        result = resolver.resolve_business_intent("How do I make apple juice?")
        assert result.matched
        assert result.intent == "off_domain"
        assert result.tool_categories == []

    def test_ack_hold_without_expected_next(self, resolver):
        result = resolver.resolve_business_intent("Okay.")
        assert result.matched
        assert result.response_mode == "hold"

    def test_ack_with_expected_isbn(self, resolver):
        from app.state.models import SessionState

        session = SessionState(
            session_id="sess4143",
            call_sid="CA41430001",
            from_number="+15551234567",
            to_number="+15559876543",
        )
        session.dialogue.expected_next = "isbn_number"
        result = resolver.resolve_business_intent("Okay.", session_state=session)
        assert result.matched
        assert result.response_mode == "direct_answer"
        assert result.direct_answer == "Go ahead. Please say the ISBN number."

    def test_identity_name(self, resolver):
        result = resolver.resolve_business_intent("What is your name?")
        assert result.matched
        assert result.intent == "identity"
        assert result.direct_answer == "My name is Eric. I'm with SureShot Books."

    def test_assistant_identity_alias(self, resolver):
        result = resolver.resolve_business_intent("Are you show short book assistant?")
        assert result.matched
        assert result.intent == "assistant_identity"
        assert "Eric" in (result.direct_answer or "")
        assert "SureShot Books assistant" in (result.direct_answer or "")
