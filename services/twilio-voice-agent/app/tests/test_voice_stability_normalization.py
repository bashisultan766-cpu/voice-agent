"""Voice Stability Normalization Layer — TTS-only text cleanup."""
from __future__ import annotations

from app.runtime.voice_commerce_runtime import (
    VoiceCommerceRuntime,
    finalize_voice_output,
    normalize_tts_text,
)


def test_normalize_removes_repeated_words():
    assert normalize_tts_text("I I need that book") == "I need that book."


def test_normalize_merges_ack_fragment():
    assert normalize_tts_text("Yes. The book is available") == (
        "Yes, the book is available."
    )


def test_normalize_expands_abbreviations():
    out = normalize_tts_text("Dr. Smith sent the ISBN.")
    assert "Doctor" in out
    assert "I S B N" in out


def test_dangling_ack_uses_user_context():
    out = normalize_tts_text("Yes.", user_text="I want that book")
    assert "about the book" in out.lower()


def test_finalize_voice_output_never_returns_raw_long_llm():
    raw = (
        "Here is a long unstructured answer with extra detail. "
        "Another sentence follows. A third should be dropped."
    )
    out = finalize_voice_output(raw, log_metrics=False)
    assert "third" not in out.lower()
    assert out


def test_format_for_tts_routes_through_finalize():
    paced = VoiceCommerceRuntime._format_for_tts("I I found your order.")
    assert "I I" not in paced
    assert "found" in paced.lower()
    assert "order" in paced.lower()


def test_email_readback_bypasses_normalization():
    readback = "Just to confirm, I heard john at gmail dot com."
    assert VoiceCommerceRuntime._format_for_tts(readback) == readback
