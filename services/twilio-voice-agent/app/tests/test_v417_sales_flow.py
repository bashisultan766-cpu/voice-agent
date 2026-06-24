"""
v4.17 — Professional ElevenLabs-style sales-flow regression tests.

Covers:
  * LLM-first sales conversation policy (need book / found / add / another / price)
  * ActiveCommerceState persistence (cart never loses the first book)
  * ISBN fragment safety (fragments never become a candidate)
  * Final response always composed by the LLM final composer after tools
"""
from __future__ import annotations

import logging
import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")


# 100,000 and Freedom Too (ISBN-13 with valid checksum)
ISBN_FREEDOM = "9780997361308"
# Hater (ISBN-13 with valid checksum)
ISBN_HATER = "9781938857669"

_BOOKS = {
    ISBN_FREEDOM: {
        "title": "100,000 and Freedom Too",
        "isbn": ISBN_FREEDOM,
        "product_id": "p_freedom",
        "variant_id": "v_freedom",
        "price": "$16.23",
        "available": True,
        "author": "",
    },
    ISBN_HATER: {
        "title": "Hater",
        "isbn": ISBN_HATER,
        "product_id": "p_hater",
        "variant_id": "v_hater",
        "price": "$34.65",
        "available": True,
        "author": "",
    },
}


def _settings(**overrides):
    from app.config import Settings

    defaults = dict(
        OPENAI_API_KEY="test",
        DEBUG=True,
        VOICE_AGENT_RUNTIME_MODE="llm_first",
    )
    defaults.update(overrides)
    return Settings(**defaults)


def _session(sid: str):
    from app.state.models import SessionState

    return SessionState(
        session_id=f"s-{sid}",
        call_sid=sid,
        from_number="+15550009999",
        to_number="+18005551234",
    )


async def _mock_lookup_isbn(isbn: str):
    book = _BOOKS.get(isbn)
    if book:
        return True, dict(book), False, {"results": [dict(book)], "count": 1}
    return False, None, False, {"found": False, "message": "no match"}


def _make_flow(settings):
    from app.agent_runtime.sales_flow import SalesFlow

    return SalesFlow(settings, lookup_isbn=_mock_lookup_isbn)


def _collector():
    captured: list[dict] = []

    async def send(msg: dict):
        captured.append(msg)

    def text() -> str:
        return " ".join(m.get("token", "") for m in captured if m.get("type") == "text").strip()

    return send, text


def _state(sid: str):
    from app.agent_runtime import active_commerce_state as acs

    return acs.load_active_commerce_state(sid)


@pytest.fixture(autouse=True)
def _clear_state():
    from app.agent_runtime import active_commerce_state as acs

    acs._STATES.clear()
    yield
    acs._STATES.clear()


@pytest.mark.asyncio
class TestSalesConversationPolicy:
    async def test_i_need_book_asks_for_isbn_title_author(self):
        sid = "CA_SALES_01"
        flow = _make_flow(_settings())
        send, text = _collector()
        result = await flow.handle(_session(sid), "I need a book.", send)
        assert result is not None and result.handled
        assert text() == "Sure — do you have the ISBN, title, or author?"

    async def test_found_book_asks_add_or_another(self):
        sid = "CA_SALES_02"
        flow = _make_flow(_settings())
        send, text = _collector()
        result = await flow.handle(_session(sid), ISBN_FREEDOM, send)
        assert result is not None and result.handled
        spoken = text()
        assert "100,000 and Freedom Too" in spoken
        assert "$16.23" in spoken
        assert "add this one" in spoken.lower()
        assert "another book" in spoken.lower()
        # The current candidate is persisted.
        assert _state(sid).current_title() == "100,000 and Freedom Too"

    async def test_add_this_persists_current_candidate_to_cart(self):
        sid = "CA_SALES_03"
        flow = _make_flow(_settings())
        session = _session(sid)
        send, _ = _collector()
        await flow.handle(session, ISBN_FREEDOM, send)
        send2, text2 = _collector()
        await flow.handle(session, "add this", send2)
        state = _state(sid)
        assert state.cart_count() == 1
        assert state.cart_lines[0]["title"] == "100,000 and Freedom Too"
        assert state.current_candidate is None

    async def test_another_book_keeps_first_book_in_cart(self):
        sid = "CA_SALES_04"
        flow = _make_flow(_settings())
        session = _session(sid)
        send, _ = _collector()
        await flow.handle(session, ISBN_FREEDOM, send)
        send2, text2 = _collector()
        result = await flow.handle(session, "I need another one.", send2)
        assert result is not None and result.handled
        assert text2() == "Of course — give me the next ISBN or title."
        # The first book is NOT forgotten — it stays in the cart.
        state = _state(sid)
        titles = [c["title"] for c in state.cart_lines]
        assert "100,000 and Freedom Too" in titles

    async def test_price_question_uses_current_candidate(self):
        sid = "CA_SALES_05"
        flow = _make_flow(_settings())
        session = _session(sid)
        send, _ = _collector()
        await flow.handle(session, ISBN_FREEDOM, send)
        send2, text2 = _collector()
        result = await flow.handle(session, "What's the price?", send2)
        assert result is not None and result.handled
        spoken = text2()
        assert "100,000 and Freedom Too" in spoken
        assert "$16.23" in spoken

    async def test_no_robotic_generic_order_first_when_candidate_exists(self):
        sid = "CA_SALES_06"
        flow = _make_flow(_settings())
        session = _session(sid)
        send, _ = _collector()
        await flow.handle(session, ISBN_FREEDOM, send)
        send2, text2 = _collector()
        await flow.handle(session, "What's the price?", send2)
        spoken = text2().lower()
        assert "what item would you like to order first" not in spoken
        assert "order first" not in spoken


@pytest.mark.asyncio
class TestIsbnFragmentSafety:
    async def test_fragment_isbn_never_saves_candidate(self):
        sid = "CA_SALES_07"
        flow = _make_flow(_settings())
        session = _session(sid)
        send, text = _collector()
        result = await flow.handle(session, "9781", send)
        assert result is not None and result.handled
        # No candidate was saved, no cart line created.
        state = _state(sid)
        assert state.current_candidate is None
        assert state.cart_count() == 0
        assert "isbn" in text().lower()

    async def test_full_isbn_beats_fragment(self):
        sid = "CA_SALES_08"
        flow = _make_flow(_settings())
        session = _session(sid)
        # A fragment first — must not select anything.
        send, _ = _collector()
        await flow.handle(session, "9781", send)
        assert _state(sid).current_candidate is None
        # The full, valid ISBN selects Hater.
        send2, _ = _collector()
        await flow.handle(session, ISBN_HATER, send2)
        assert _state(sid).current_title() == "Hater"


class TestIsbnFragmentHelpers:
    def test_candidate_guard_blocks_isbn_fragment(self):
        from app.cart.candidate_guard import should_save_candidate

        allowed, reason = should_save_candidate("isbn_search", "9781", is_isbn=True)
        assert allowed is False
        assert reason == "isbn_fragment"

        allowed2, _ = should_save_candidate("isbn_search", "9780", is_isbn=True)
        assert allowed2 is False

    def test_business_resolver_ignores_isbn_fragment(self):
        from app.agent_runtime.business_intent_resolver import extract_isbn_from_text

        assert extract_isbn_from_text("9781") is None
        assert extract_isbn_from_text("9780") is None
        assert extract_isbn_from_text(ISBN_HATER) == ISBN_HATER

    def test_isbn_assembles_across_turns(self):
        from app.pipeline.isbn_validator import process_isbn_buffer

        r1 = process_isbn_buffer("9780997361", "")
        assert r1.action == "ask_remaining"
        r2 = process_isbn_buffer("3 0 8", r1.buffer)
        assert r2.action == "complete"
        assert r2.isbn == ISBN_FREEDOM


@pytest.mark.asyncio
class TestFinalResponseByLLM:
    async def test_final_response_generated_by_llm_after_tools(self, caplog):
        sid = "CA_SALES_09"
        flow = _make_flow(_settings())
        caplog.set_level(logging.INFO)
        send, _ = _collector()
        result = await flow.handle(_session(sid), ISBN_FREEDOM, send)
        assert result is not None and result.handled
        # The ISBN lookup tool ran and its result is captured.
        assert result.tool_results and "SearchBookByISBN" in result.tool_results
        # The final spoken response went through the LLM final composer.
        assert "llm_final_response_started" in caplog.text
        assert "llm_final_response_completed" in caplog.text

    async def test_commerce_state_saved_and_loaded_logs(self, caplog):
        sid = "CA_SALES_10"
        flow = _make_flow(_settings())
        caplog.set_level(logging.INFO)
        send, _ = _collector()
        await flow.handle(_session(sid), ISBN_FREEDOM, send)
        assert "commerce_state_loaded" in caplog.text
        assert "commerce_state_saved" in caplog.text


@pytest.mark.asyncio
class TestAcceptanceTwoBookFlow:
    async def test_full_two_book_call_flow(self, caplog):
        sid = "CA_SALES_FLOW"
        flow = _make_flow(_settings())
        session = _session(sid)
        caplog.set_level(logging.INFO)

        # 1) I need a book.
        send, text = _collector()
        await flow.handle(session, "I need a book.", send)
        assert text() == "Sure — do you have the ISBN, title, or author?"

        # 2) First ISBN -> found, offer add or another.
        send, text = _collector()
        await flow.handle(session, ISBN_FREEDOM, send)
        assert "100,000 and Freedom Too" in text()
        assert "$16.23" in text()

        # 3) I need another one -> keep first book, ask for next.
        send, text = _collector()
        await flow.handle(session, "I need another one.", send)
        assert text() == "Of course — give me the next ISBN or title."
        assert _state(sid).cart_count() == 1

        # 4) Second ISBN -> found, ask to add both.
        send, text = _collector()
        await flow.handle(session, ISBN_HATER, send)
        spoken = text()
        assert "Hater" in spoken
        assert "$34.65" in spoken
        assert "both books" in spoken.lower()

        # 5) Yes -> both books in cart, offer payment link.
        send, text = _collector()
        await flow.handle(session, "Yes.", send)
        spoken = text()
        assert "both books" in spoken.lower()
        assert "payment link" in spoken.lower()
        assert _state(sid).cart_count() == 2

        # Logs: cart grew 1 -> 2 across the call.
        assert "cart_lines=1" in caplog.text
        assert "cart_lines=2" in caplog.text

    async def test_another_one_is_not_payment_request(self):
        from app.agent_runtime import active_commerce_state as acs
        from app.agent_runtime.sales_flow import classify_sales_turn

        state = acs.ActiveCommerceState(sid="CA_X")
        assert classify_sales_turn("I need another one.", state) != "payment_request"
        assert classify_sales_turn("I need another one.", state) == "another_book"
