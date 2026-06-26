"""v4.14.6 — Latest live deadline regression tests (CA104c scenarios)."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("VOICE_AGENT_RUNTIME_MODE", "main_llm_agent")

from app.agent_runtime.business_intent_resolver import resolve_business_intent
from app.agent_runtime.commerce_commit_resolver import resolve_commerce_commit
from app.agent_runtime.commerce_session import (
    ProductCandidate,
    cart_summary,
    clear_commerce_session,
    get_commerce_session,
    update_candidates_from_facts,
)
from app.agent_runtime.demo_hardening import is_commerce_demo_hardening
from app.agent_runtime.payment_link_orchestrator import handle_payment_request
from app.agent_runtime.tool_entity_extractor import extract_tool_entities, is_payment_link_phrase
from app.config import get_settings


def _seed(sid: str = "CA104c"):
    clear_commerce_session(sid)
    session = get_commerce_session(sid)
    update_candidates_from_facts(session, [
        ProductCandidate(
            candidate_id="live1",
            product_id="p1",
            variant_id="v1",
            title="When Scars Become Stories",
            author=None,
            isbn="9798893960648",
            price="$16.99",
            currency="USD",
            availability="available",
            inventory_quantity=5,
            source="isbn",
            confidence=0.99,
        )
    ])
    session.expected_next = "add_to_cart_offer"
    session.last_product_answer = (
        "I found When Scars Become Stories. The price is 16.99. "
        "It looks available. Would you like me to add it to your order?"
    )
    return session


def _state(sid: str = "CA104c"):
    from app.state.models import SessionState

    s = SessionState(
        session_id=f"sess{sid}",
        call_sid=sid,
        from_number="+15551234567",
        to_number="+15559876543",
    )
    s.last_product_candidate = {
        "candidate_id": "live1",
        "title": "When Scars Become Stories",
        "variant_id": "v1",
        "product_id": "p1",
    }
    return s


class TestLatestLiveDeadlineRegression:
    def test_ca104c_yes_and_another_book(self):
        commerce = _seed()
        result = resolve_commerce_commit(
            "Yes. I need this 1, and I need another book.",
            commerce,
        )
        assert result.matched
        assert cart_summary(commerce)["count"] == 1
        assert "product_phrase" not in extract_tool_entities(
            "Yes. I need this 1, and I need another book."
        )

    def test_ca104c_i_need_these_2_books(self):
        commerce = _seed()
        biz = resolve_business_intent("I need these 2 book.", session_state=_state())
        assert biz.intent != "book_title_search"
        commit = resolve_commerce_commit("I need these 2 book.", commerce)
        assert commit.intent == "multi_book_collection_start"

    def test_ca104c_send_payment_link_empty_cart_candidates(self):
        commerce = _seed()
        from app.state.models import SessionState

        state = SessionState(
            session_id="s1",
            call_sid="CA104c",
            from_number="+1",
            to_number="+2",
        )
        pay = handle_payment_request(commerce, session_state=state)
        assert "Your order is empty right now" not in pay["message"]

    def test_ca104c_two_isbn_declaration(self):
        commerce = _seed()
        commit = resolve_commerce_commit(
            "I give you the 2 ISBN numbers of 2 different books.",
            commerce,
        )
        assert commit.matched
        assert commit.intent == "multi_book_collection_start"
        biz = resolve_business_intent(
            "I give you the 2 ISBN numbers of 2 different books.",
            session_state=_state(),
        )
        assert biz.intent != "unknown"

    def test_ca104c_pen_and_link(self):
        assert is_payment_link_phrase("Can you send me the pen and link of the those books?")
        commerce = _seed()
        commit = resolve_commerce_commit(
            "Can you send me the pen and link of the those books?",
            commerce,
        )
        assert commit.intent == "payment_flow"

    def test_demo_hardening_enabled(self, monkeypatch):
        # v4.18: "demo hardening" made the deterministic commerce resolver win
        # over the LLM. That anti-LLM override is removed; the LLM-first runtime
        # is authoritative, so demo hardening is OFF by the code default.
        monkeypatch.setenv("VOICE_AGENT_RUNTIME_MODE", "llm_tool_runtime")
        monkeypatch.setenv("VOICE_COMMERCE_DEMO_HARDENING", "false")
        from app.config import Settings
        assert is_commerce_demo_hardening(Settings()) is False

    def test_no_legacy_runtime(self):
        assert get_settings().VOICE_AGENT_RUNTIME_MODE != "legacy_v410"

    def test_openai_tools_blocked(self):
        assert get_settings().VOICE_LIVE_DISABLE_OPENAI_TOOLS is True

    @pytest.mark.asyncio
    async def test_i_need_this_book_via_business_intent(self):
        commerce = _seed()
        state = _state()
        biz = resolve_business_intent("I need this book.", session_state=state)
        assert biz.intent == "cart_mutation"
        assert "added" in (biz.direct_answer or "").lower()
        assert cart_summary(commerce)["count"] == 1

    def test_these_books_isbn_phrase_not_title(self):
        entities = extract_tool_entities(
            "these 2 books. I give you the 2 ISBN number of 2 books"
        )
        assert "product_phrase" not in entities
