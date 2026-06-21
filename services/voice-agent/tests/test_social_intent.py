"""Social intent and filler gating tests."""
from __future__ import annotations

from app.pipeline.social_intent import (
    is_social_utterance,
    should_play_filler,
    social_response_text,
)


def test_hello_how_are_you_is_social() -> None:
    assert is_social_utterance("hello how are you")
    assert is_social_utterance("Hello, how are you?")
    assert is_social_utterance("hey")


def test_order_lookup_is_not_social() -> None:
    assert not is_social_utterance("track my order 12345")
    assert not is_social_utterance("do you have books about chess")


def test_filler_skipped_for_social() -> None:
    assert not should_play_filler("hello how are you")
    assert not should_play_filler("hi there")


def test_filler_for_tool_intent() -> None:
    assert should_play_filler("where is my order 12345")
    assert should_play_filler("do you have books about cooking")
    assert should_play_filler("lookup order 5678", pre_fetched={"k": "cached"})
    assert not should_play_filler("hello", pre_fetched={"k": "cached"})


def test_social_response_non_empty() -> None:
    assert "help you" in social_response_text().lower()
