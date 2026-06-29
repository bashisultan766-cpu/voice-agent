"""All domain email types: capture, slow readback, fine/correct confirm (v4.53)."""
from __future__ import annotations

import pytest

from app.email.capture import is_email_confirmation, normalize_spoken_email
from app.email.resolver import resolve_spoken_email_address
from app.email.speller import speak_email, spell_email_letter_by_letter
from app.payment.payment_state_machine import capture_payment_email, process_payment_turn, speak_confirmation_prompt
from app.state.models import SessionState


@pytest.mark.parametrize(
    "spoken,expected",
    [
        ("john at gmail dot com", "john@gmail.com"),
        ("john at yahoo dot com", "john@yahoo.com"),
        ("bob at hotmail dot com", "bob@hotmail.com"),
        ("alice at outlook dot com", "alice@outlook.com"),
        ("user at icloud dot com", "user@icloud.com"),
        ("test at protonmail dot com", "test@protonmail.com"),
        ("x at googlemail dot com", "x@gmail.com"),
        ("m at g mail dot c o m", "m@gmail.com"),
        ("john at y a h o o dot c o m", "john@yahoo.com"),
        ("sales at sureshotbooks dot com", "sales@sureshotbooks.com"),
        ("jane at company dot co dot uk", "jane@company.co.uk"),
        ("info at mail dot com", "info@mail.com"),
        ("pat at att dot net", "pat@att.net"),
    ],
)
def test_all_domain_types_capture(spoken: str, expected: str):
    assert normalize_spoken_email(spoken) == expected
    assert resolve_spoken_email_address(spoken).email == expected


@pytest.mark.parametrize(
    "phrase",
    [
        "yes",
        "that's correct",
        "that is correct",
        "that's true",
        "that's fine",
        "that is fine",
        "it's fine",
        "yes that's correct it's fine",
        "right",
        "sounds good",
    ],
)
def test_email_confirmation_phrases(phrase: str):
    assert is_email_confirmation(phrase)


def test_custom_domain_slow_readback():
    email = "sales@sureshotbooks.com"
    prompt = speak_confirmation_prompt(email)
    assert "Slowly, letter by letter" in prompt
    spelled = spell_email_letter_by_letter(email)
    assert "S. U. R. E. S. H. O. T. B. O. O. K. S" in spelled
    assert "C. O. M" in spelled
    assert speak_email(email) == "sales at sureshotbooks dot com"


def test_yahoo_confirm_sends_payment_path():
    session = SessionState(
        session_id="s",
        call_sid="CA1",
        from_number="+15551230001",
        to_number="+15559990001",
        cart_items=[{"title": "Book", "variant_id": "v1", "quantity": 1}],
        payment_flow_status="awaiting_email",
        awaiting_payment_email=True,
    )
    hint = capture_payment_email(session, "buyer@yahoo.com")
    assert "yahoo dot com" in hint.force_reply
    assert "Slowly, letter by letter" in hint.force_reply

    confirm = process_payment_turn(session, "that's fine")
    assert session.payment_email_confirmed
    assert session.confirmed_email == "buyer@yahoo.com"
    assert confirm.email_confirmed or session.payment_flow_status == "awaiting_send_confirmation"
