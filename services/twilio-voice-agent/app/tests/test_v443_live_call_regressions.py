"""v4.43 — CAce98 regressions: underscore ISBN, just 1 copy, silence during ISBN hold."""
from __future__ import annotations

from app.agent_runtime.commerce_flow_state import (
    COMMERCE_FLOW_VERSION,
    STATUS_AWAITING_QUANTITY,
    advance_commerce_state_silent,
    stage_product_candidate,
)
from app.agent_runtime.isbn_short_circuit import (
    ISBN_SHORT_CIRCUIT_VERSION,
    prepare_isbn_turn_context,
    should_skip_isbn_digit_collection,
)
from app.state.models import SessionState
from app.tools.isbn import expand_spoken_repeaters, extract_isbn_candidate
from app.voice.turn_taking import is_complete_isbn


def _session(**kwargs) -> SessionState:
    base = dict(
        session_id="v443",
        call_sid="CAce98d776968af0514ea520da074df796",
        from_number="+1",
        to_number="+2",
    )
    base.update(kwargs)
    return SessionState(**base)


class TestV443:
    def test_versions(self):
        assert ISBN_SHORT_CIRCUIT_VERSION == "v4.44"
        assert COMMERCE_FLOW_VERSION == "v4.51"

    def test_underscore_stripped_from_isbn(self):
        text = "The ISBN number is 9 7 8 underscore 9083434964."
        expanded = expand_spoken_repeaters(text)
        isbn = extract_isbn_candidate(expanded)
        assert isbn == "9789083434964"

    def test_just_one_copy_skips_isbn_buffer(self):
        session = _session(
            commerce_flow_status=STATUS_AWAITING_QUANTITY,
            commerce_pending_candidate={"title": "Can I Take It?", "variant_id": "v1"},
        )
        session.last_resolved_isbn_for_turn = "9789083434964"
        assert should_skip_isbn_digit_collection(session, "Just 1 copy.")
        prepare_isbn_turn_context(session, "Just 1 copy.")
        assert getattr(session, "pending_isbn_buffer", "") == ""
        assert session.last_resolved_isbn_for_turn == "9789083434964"

    def test_yes_on_awaiting_quantity_unlocks_add(self):
        session = _session()
        stage_product_candidate(
            session,
            {"title": "A Feast for Crows", "variant_id": "v1", "isbn": "9780553582024"},
        )
        advance_commerce_state_silent(session, "Yes.")
        assert session.commerce_pending_quantity == 1
        assert session.commerce_allow_add is True

    def test_sliding_window_isbn_when_extra_digits(self):
        assert is_complete_isbn(
            "I give you another ISBN 9780553582024 extra 964 junk"
        )
