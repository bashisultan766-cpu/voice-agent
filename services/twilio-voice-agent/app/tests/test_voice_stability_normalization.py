"""Voice Stability Normalization Layer — TTS-only text cleanup."""
from __future__ import annotations

from app.runtime.voice_commerce_runtime import (
    FinalVoicePipelineResult,
    TtsSentenceCompleteBuffer,
    VoiceCommerceRuntime,
    clear_tts_sentence_cache,
    final_voice_pipeline,
    finalize_voice_output,
    normalize_tts_text,
)
from app.state.models import SessionState
from app.voice.voice_response_formatter import SpeechPacer
import re


def _session() -> SessionState:
    return SessionState(
        session_id="tts",
        call_sid="CA_TTS",
        from_number="+1",
        to_number="+2",
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


def test_email_readback_gets_unified_pacing():
    readback = (
        "Just to confirm, I heard john at gmail dot com. "
        "Slowly, letter by letter, that is j o h n at gmail dot com. Is that correct?"
    )
    paced = VoiceCommerceRuntime._format_for_tts(readback)
    assert "letter by letter" in paced.lower()
    assert re.search(r"\.{2,}", paced)
    assert "Just to confirm" in paced


def test_product_flow_pacing_matches_order_rhythm():
    raw = (
        "Found it — Atomic Habits. It's 12 dollars. "
        "How many copies would you like?"
    )
    paced = SpeechPacer().pace(raw, emotion_field={"valence": 0, "arousal": 0.3, "stability": 0.7})
    assert "Atomic Habits" in paced
    assert "copies" in paced.lower()
    assert re.search(r"\.{2,}", paced)
    lines = [line for line in paced.splitlines() if line.strip()]
    assert len(lines) >= 2


def test_payment_instruction_pause_before_link():
    raw = (
        "Your cart has 2 books. "
        "You will receive a secure Shopify payment link. It contains your order summary."
    )
    paced = SpeechPacer().pace(raw, emotion_field={"valence": 0, "arousal": 0.3, "stability": 0.7})
    assert "payment link" in paced.lower()
    assert re.search(r"\.{2,}", paced)
    assert "\n" in paced or " .. " in paced.replace("\n", " .. ")


def test_added_product_quantity_pacing():
    raw = "Got it — added 2 copies of Deep Work. Do you want another product?"
    paced = SpeechPacer().pace(raw, emotion_field={"valence": 0, "arousal": 0.3, "stability": 0.7})
    assert "2 copies" in paced
    assert "Deep Work" in paced
    assert re.search(r"\.{2,}", paced)


def test_finalize_preserves_speech_pacer_pauses():
    session = SessionState(
        session_id="s",
        call_sid="CA1",
        from_number="+1",
        to_number="+2",
    )
    out = finalize_voice_output(
        "Found it — Atomic Habits. How many copies would you like?",
        session,
        log_metrics=False,
    )
    assert "Atomic Habits" in out
    assert re.search(r"\.{2,}", out)


def test_final_voice_pipeline_strips_partial_cuts():
    result = final_voice_pipeline(
        "I found your order fro today",
        require_complete=False,
        allow_short=True,
    )
    assert isinstance(result, FinalVoicePipelineResult)
    assert "fro" not in result.text.lower()


def test_final_voice_pipeline_blocks_incomplete_sentence():
    result = final_voice_pipeline(
        "This is an incomplete thought without ending",
        require_complete=True,
        allow_short=False,
    )
    assert result.blocked is True
    assert result.reason == "incomplete_sentence"
    assert result.text == ""


def test_final_voice_pipeline_blocks_short_stream_chunk():
    result = final_voice_pipeline(
        "Hello there.",
        require_complete=True,
        allow_short=False,
    )
    assert result.blocked is True
    assert result.reason == "too_short"


def test_final_voice_pipeline_allows_complete_sentence_with_min_words():
    result = final_voice_pipeline(
        "Please provide ISBN or book title.",
        require_complete=True,
        allow_short=False,
    )
    assert result.blocked is False
    assert "book title" in result.text.lower()


def test_sentence_buffer_never_emits_partial():
    buf = TtsSentenceCompleteBuffer()
    buf.feed("This is the first complete sentence. This is st")
    ready = buf.drain_complete_sentences()
    assert len(ready) == 1
    assert ready[0].endswith(".")
    assert "st" in buf.pending


def test_sentence_buffer_flushes_remainder_on_stream_end():
    buf = TtsSentenceCompleteBuffer()
    buf.feed("Only one streaming fragment without terminal")
    assert buf.drain_complete_sentences() == []
    remainder = buf.flush_remainder()
    assert "terminal" in remainder


def test_stream_chunk_blocks_incomplete_llm_fragment():
    blocked = VoiceCommerceRuntime._format_stream_chunk("partial stream bu")
    assert blocked == ""


def test_sentence_cache_merges_continuation():
    session = _session()
    clear_tts_sentence_cache(session)
    first = final_voice_pipeline(
        "This is the first valid sentence.",
        session,
        require_complete=True,
        allow_short=False,
    )
    assert first.blocked is False
    second = final_voice_pipeline(
        "this continues the thought nicely.",
        session,
        require_complete=True,
        allow_short=False,
    )
    assert second.blocked is False
    assert "first valid sentence" in second.text.lower()
