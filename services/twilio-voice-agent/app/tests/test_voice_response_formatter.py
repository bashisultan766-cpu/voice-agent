"""Tests for VoiceResponseFormatter — voice TTS normalization layer."""
from __future__ import annotations

import re

from app.state.models import SessionState
from app.voice.voice_response_formatter import (
    MAX_SPEECH_CHARS,
    EmotionPacingProfile,
    SpeechPacer,
    VoiceResponseFormatter,
    _apply_prosody_emphasis,
    _apply_semantic_chunk_prosody,
    _apply_speech_flow_curve,
    _normalize_money_in_text,
    _pronounce_usd_amount,
    _render_emphasis_pacing,
    default_emotion_field,
    emotion_pacing_profile,
    evolve_emotion_field,
    format_voice_response,
    note_emotion_interrupt,
)

def test_strips_internal_reasoning_and_json():
    raw = (
        '{"order_id": 12345, "status": "paid"} '
        "Let me think about this. Based on the tool result, "
        "your order shipped yesterday. Would you like tracking details?"
    )
    out = format_voice_response(raw)
    assert "order_id" not in out.speech_text.lower()
    assert "tool result" not in out.speech_text.lower()
    assert "shipped" in out.speech_text.lower()
    assert out.next_action == "ask"
    assert out.should_pause is True


def test_primary_message_max_two_sentences_one_question():
    raw = (
        "First point about your cart. Second point about shipping. "
        "Third unnecessary detail. Fourth even more detail. "
        "Would you like to checkout? Can I help with anything else?"
    )
    out = format_voice_response(raw)
    assert out.speech_text.count("?") <= 1
    assert "anything else" in out.speech_text.lower() or "checkout" in out.speech_text.lower()
    assert len(out.speech_text) <= MAX_SPEECH_CHARS


def test_compresses_over_240_chars():
    raw = " ".join(["This is sentence number {}.".format(i) for i in range(1, 12)])
    assert len(raw) > MAX_SPEECH_CHARS
    out = format_voice_response(raw)
    assert len(out.speech_text) <= MAX_SPEECH_CHARS
    assert out.speech_text.endswith((".", "!", "?"))


def test_close_action_detected():
    out = format_voice_response(
        "You're all set. Thank you for calling SureShot Books. Have a great day."
    )
    assert out.next_action == "close"
    assert out.should_pause is False


def test_confirm_action_detected():
    out = format_voice_response("I heard john at gmail dot com. Is that correct?")
    assert out.next_action == "confirm"
    assert out.should_pause is True


def test_answer_action_for_plain_statement():
    out = format_voice_response("Your order is on the way and should arrive Friday.")
    assert out.next_action == "answer"
    assert out.should_pause is False


def test_removes_bullet_database_dump():
    raw = (
        "Here is your order:\n"
        "- order_number: 1042\n"
        "- status: fulfilled\n"
        "- total: 49.99\n"
        "- email: hidden\n"
        "It shipped two days ago."
    )
    out = format_voice_response(raw)
    assert "order_number" not in out.speech_text
    assert "shipped" in out.speech_text.lower()


def test_output_shape_fields():
    out = VoiceResponseFormatter().format("Hello. How can I help?")
    assert isinstance(out.speech_text, str)
    assert isinstance(out.should_pause, bool)
    assert out.next_action in ("ask", "answer", "confirm", "close")


def test_pronounce_usd_amount_with_cents():
    assert _pronounce_usd_amount(90.99) == "90 dollars and 99 cents"
    assert _pronounce_usd_amount(90.0) == "90 dollars"
    assert _pronounce_usd_amount(0.99) == "99 cents"


def test_normalize_money_in_text():
    assert _normalize_money_in_text("Total is $90.99 today.") == (
        "Total is 90 dollars and 99 cents today."
    )


def test_speech_pacer_adds_pauses_per_idea():
    neutral_emotion = {"valence": 0.0, "arousal": 0.3, "stability": 0.3}
    paced = SpeechPacer().pace(
        "I found your order. You have 3 items. Total is 90 dollars.",
        emotion_field=neutral_emotion,
    )
    lines = paced.splitlines()
    assert len(lines) == 3
    assert "I found" in lines[0]
    assert "3 items" in lines[1]
    assert "90 dollars" in lines[2]
    assert "..." in paced


def test_speech_flow_entry_pause():
    flat = EmotionPacingProfile(pause_scale=1.0)
    curved = _apply_speech_flow_curve("I found your order today", flat)
    assert curved.startswith("I found..")


def test_speech_flow_peak_before_order_id():
    flat = EmotionPacingProfile(pause_scale=1.0)
    emphasized = _apply_prosody_emphasis("I found your order 47908 for you")
    curved = _apply_speech_flow_curve(emphasized, flat)
    assert ".." in curved
    assert "47908" in curved


def test_speech_flow_short_chunk_unchanged_for_streaming():
    flat = EmotionPacingProfile(pause_scale=1.0)
    short = "Got it"
    assert _apply_speech_flow_curve(short, flat) == short
    paced = SpeechPacer().pace("Got it.", emotion_field={"valence": 0, "arousal": 0.3, "stability": 0.3})
    assert "Got it" in paced


def test_prosody_emphasis_money():
    assert _apply_prosody_emphasis("Your order total is 90 dollars") == (
        "Your order total is *90 dollars*"
    )
    assert _apply_prosody_emphasis("Total is $90.99 today.") == (
        "Total is *$90.99* today."
    )


def test_prosody_emphasis_order_id():
    assert _apply_prosody_emphasis("I found order 47908 for you.") == (
        "I found *order 47908* for you."
    )
    assert _apply_prosody_emphasis("Looking up #47908 now.") == (
        "Looking up *#47908* now."
    )


def test_prosody_emphasis_confirmations_mild():
    assert _apply_prosody_emphasis("Your order is paid and shipped.") == (
        "Your order is (paid) and (shipped)."
    )


def test_prosody_emphasis_failures_strong():
    assert _apply_prosody_emphasis("Payment failed.") == (
        "Payment **failed**."
    )
    assert _apply_prosody_emphasis("We were unable to process that.") == (
        "We were **unable** to process that."
    )


def test_render_emphasis_pacing_tiers():
    flat = EmotionPacingProfile(pause_scale=1.0, emphasis_pause_boost=1.0)
    assert _render_emphasis_pacing("Status is (paid) today.", flat) == (
        "Status is ..paid.. today."
    )
    assert _render_emphasis_pacing("Your total is *90 dollars* today.", flat) == (
        "Your total is ...90 dollars... today."
    )
    assert _render_emphasis_pacing("Payment **failed**.", flat) == (
        "Payment ......failed......"
    )


def test_format_applies_semantic_normalization_without_pacing():
    session = SessionState(
        session_id="s",
        call_sid="CA1",
        from_number="+1",
        to_number="+2",
    )
    out = format_voice_response(
        "I found your order. You have 3 items. Total is $90.99.",
        session,
        user_text="check my order",
    )
    assert "I found" in out.speech_text
    assert "your order" in out.speech_text
    assert "3 items" in out.speech_text
    assert "$90.99" in out.speech_text
    assert not re.search(r"\.{2,}", out.speech_text)
    assert "*" not in out.speech_text
    assert "(" not in out.speech_text
    assert session.emotion_field["valence"] > default_emotion_field()["valence"]
    assert len(out.speech_text) <= MAX_SPEECH_CHARS


def test_emotion_field_evolves_on_error():
    session = SessionState(
        session_id="s",
        call_sid="CA1",
        from_number="+1",
        to_number="+2",
    )
    start = default_emotion_field()["valence"]
    evolve_emotion_field(session, response_text="Payment failed.", user_text="")
    assert session.emotion_field["valence"] < start
    assert session.emotion_field["arousal"] > default_emotion_field()["arousal"]


def test_emotion_field_evolves_on_calm_user():
    session = SessionState(
        session_id="s",
        call_sid="CA1",
        from_number="+1",
        to_number="+2",
    )
    start = session.emotion_field["stability"]
    evolve_emotion_field(session, response_text="Got it.", user_text="okay")
    assert session.emotion_field["stability"] > start


def test_note_emotion_interrupt_reduces_stability():
    session = SessionState(
        session_id="s",
        call_sid="CA1",
        from_number="+1",
        to_number="+2",
    )
    start = session.emotion_field["stability"]
    note_emotion_interrupt(session)
    assert session.emotion_field["stability"] < start


def test_semantic_chunk_prosody_marks_product_and_quantity():
    marked = _apply_semantic_chunk_prosody(
        "Found it — Atomic Habits. How many copies would you like?"
    )
    assert "*Atomic Habits*" in marked
    assert "*How many copies*" in marked
    assert "\n" in marked


def test_semantic_chunk_prosody_before_payment_and_email():
    marked = _apply_semantic_chunk_prosody(
        "Your cart is ready. You will receive a secure Shopify payment link. "
        "Just to confirm, I heard you. Slowly, letter by letter, that is the email."
    )
    assert "\nYou will receive" in marked
    assert "*secure Shopify payment link*" in marked
    assert "\nSlowly" in marked
    assert "*letter by letter*" in marked


def test_high_arousal_shortens_chunks():
    calm = emotion_pacing_profile({"valence": 0.0, "arousal": 0.1, "stability": 0.9})
    excited = emotion_pacing_profile({"valence": 0.0, "arousal": 0.9, "stability": 0.2})
    assert excited.max_idea_words < calm.max_idea_words
    assert excited.pause_scale > calm.pause_scale


def test_negative_valence_adds_emphasis_pauses():
    neutral = emotion_pacing_profile({"valence": 0.2, "arousal": 0.3, "stability": 0.7})
    negative = emotion_pacing_profile({"valence": -0.8, "arousal": 0.5, "stability": 0.4})
    assert negative.emphasis_pause_boost > neutral.emphasis_pause_boost
