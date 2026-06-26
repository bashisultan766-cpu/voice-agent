"""Conversational handling tests: ISBN offer + yes/pending action (v4.17)."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.state.models import SessionState
from app.agent_runtime.business_intent_resolver import resolve_business_intent
from app.agent_runtime import pending_action as pa


def _session(sid="CA_CONV001") -> SessionState:
    return SessionState(
        session_id="s-conv",
        call_sid=sid,
        from_number="+15550003434",
        to_number="+18005551234",
    )


class TestIsbnOffer:
    def test_can_i_give_you_isbn_is_not_unknown(self):
        result = resolve_business_intent("Can I give you the ISBN number?")
        assert result.matched is True
        assert result.intent != "unknown"
        assert result.intent == "isbn_collection_start"
        # Conversational accept — answered directly, no premature tool call.
        assert result.response_mode == "direct_answer"
        assert result.tool_categories == []
        assert "ISBN" in (result.direct_answer or "")

    def test_isbn_offer_variants_not_unknown(self):
        for text in (
            "Can I give you the ISBN number of the book?",
            "I have ISBN",
            "I can give you the ISBN",
        ):
            result = resolve_business_intent(text)
            assert result.matched is True, text
            assert result.intent != "unknown", text


class TestYesPendingAction:
    def test_yes_uses_pending_action(self):
        session = _session()
        pa.set_pending_action(
            session, "send_payment_link", payload={"email": "x@example.com"},
            prompt="Want me to send the payment link?",
        )
        action = pa.consume_if_affirmative(session, "yes please")
        assert action is not None
        assert action.action == "send_payment_link"
        assert action.payload["email"] == "x@example.com"
        # Pending action is cleared after use.
        assert pa.get_pending_action(session) is None

    def test_no_clears_pending_action(self):
        session = _session("CA_CONV002")
        pa.set_pending_action(session, "send_payment_link")
        action = pa.consume_if_affirmative(session, "no thanks")
        assert action is None
        assert pa.get_pending_action(session) is None

    def test_yes_without_pending_returns_none(self):
        session = _session("CA_CONV003")
        assert pa.consume_if_affirmative(session, "yes") is None

    def test_affirmative_negative_detection(self):
        assert pa.is_affirmative("yes")
        assert pa.is_affirmative("sure, go ahead")
        assert pa.is_negative("no")
        assert pa.is_negative("not now")
        assert not pa.is_affirmative("no")
        assert not pa.is_negative("yes")


class TestToolSurface:
    def test_new_tools_registered(self):
        from app.tools.registry import _TOOL_MAP

        for name in (
            "SearchBookByISBN", "SearchBookByTitle",
            "SearchCustomerByPhone", "SearchOrdersByPhone",
        ):
            assert name in _TOOL_MAP

    def test_search_book_by_isbn_rejects_fragment(self):
        import asyncio
        import json

        from app.tools.shopify_tools import SearchBookByISBN

        out = json.loads(asyncio.run(SearchBookByISBN("9780")))
        assert out["found"] is False
        assert out.get("needs_more_digits") is True
