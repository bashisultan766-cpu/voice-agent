"""
v4.2 tests — ISBNFragmentAccumulatorWorker.

Verifies multi-turn ISBN collection across multiple spoken fragments.
"""
from __future__ import annotations

import os
import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.state.models import SessionState
from app.workers.isbn_fragment_worker import ISBNFragmentAccumulatorWorker, _extract_digits, _is_valid_isbn


def _session():
    return SessionState(
        session_id="s-isbn", call_sid="CA_ISBN01",
        from_number="+15551234567", to_number="+18005551234",
    )


def _settings():
    from app.config import Settings
    return Settings(OPENAI_API_KEY="test", DEBUG=True)


class TestExtractDigits:
    def test_plain_digits(self):
        assert _extract_digits("9 7 8 1 4 0 0 3 5 7") == "9781400357"

    def test_digit_words(self):
        assert _extract_digits("nine seven eight one") == "9781"

    def test_oh_becomes_zero(self):
        assert _extract_digits("oh one two") == "012"

    def test_mixed(self):
        assert _extract_digits("978 one four zero zero") == "9781400"

    def test_strips_non_digits(self):
        assert _extract_digits("isbn 978-1400357949") == "9781400357949"


class TestIsValidISBN:
    def test_valid_isbn13(self):
        assert _is_valid_isbn("9780441172719")

    def test_invalid_isbn13(self):
        assert not _is_valid_isbn("9780441172710")

    def test_valid_isbn10(self):
        assert _is_valid_isbn("0441172717")

    def test_partial_not_valid(self):
        assert not _is_valid_isbn("9781400")


class TestISBNFragmentAccumulator:
    async def test_single_complete_isbn(self):
        worker = ISBNFragmentAccumulatorWorker()
        session = _session()
        session.turn_count = 1
        result = await worker.run(session, {"raw_text": "9780441172719"}, _settings())
        assert result.success
        assert result.data["action"] == "complete"
        assert result.data["isbn"] == "9780441172719"

    async def test_accumulates_across_turns(self):
        worker = ISBNFragmentAccumulatorWorker()
        session = _session()

        # Turn 1: partial
        session.turn_count = 1
        r = await worker.run(session, {"raw_text": "9 7 8 1"}, _settings())
        assert r.success
        assert r.data["action"] == "accumulating"
        assert session.isbn_buffer == "9781"

        # Turn 2: more digits
        session.turn_count = 2
        r = await worker.run(session, {"raw_text": "4 0 0 3"}, _settings())
        assert session.isbn_buffer == "97814003"

        # Turn 3: complete
        session.turn_count = 3
        r = await worker.run(session, {"raw_text": "5 7 9 4 9"}, _settings())
        assert r.success
        assert r.data["action"] == "complete"
        assert r.data["isbn"] == "9781400357949"
        assert session.isbn_buffer == ""  # reset after complete

    async def test_restart_clears_buffer(self):
        worker = ISBNFragmentAccumulatorWorker()
        session = _session()
        session.isbn_buffer = "97814"
        session.isbn_buffer_turn = 1
        session.turn_count = 2

        r = await worker.run(session, {"raw_text": "start over"}, _settings())
        assert session.isbn_buffer == ""
        assert r.data["action"] == "restarted"

    async def test_isbn_stored_in_history(self):
        worker = ISBNFragmentAccumulatorWorker()
        session = _session()
        session.turn_count = 1
        await worker.run(session, {"raw_text": "9780441172719"}, _settings())
        assert "9780441172719" in session.isbn_history

    async def test_expired_buffer_resets(self):
        worker = ISBNFragmentAccumulatorWorker()
        session = _session()
        session.isbn_buffer = "9781"
        session.isbn_buffer_turn = 0
        session.turn_count = 10  # 10 turns later

        # Should have reset the buffer since >5 turns passed
        r = await worker.run(session, {"raw_text": "4 0 0"}, _settings())
        # Buffer should only have the new digits
        assert session.isbn_buffer == "400"

    async def test_no_digits_returns_failure(self):
        worker = ISBNFragmentAccumulatorWorker()
        session = _session()
        session.turn_count = 1
        r = await worker.run(session, {"raw_text": "hello there"}, _settings())
        assert not r.success
        assert r.error_code == "no_digits"
