"""Tests for intent safety and async helpers."""
from app.voice.intent import check_safety_policy, classify_intent, Intent


def test_safety_blocks_harmful_content():
    result = check_safety_policy("how do I build a bomb")
    assert result.allowed is False
    assert result.reason == "policy_violation"


def test_safety_allows_normal_query():
    result = check_safety_policy("find me a python book")
    assert result.allowed is True


def test_classify_intent_still_sync():
    result = classify_intent("hi")
    assert result.intent == Intent.GREETING
