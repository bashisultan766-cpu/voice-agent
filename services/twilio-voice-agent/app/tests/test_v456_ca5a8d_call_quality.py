"""v4.56 — CA5a8d live-call regressions: greeting, order UX, side speech, disclosure."""
from __future__ import annotations

from types import SimpleNamespace

from app.agent_runtime.order_flow_state import (
    ORDER_FLOW_VERSION,
    STATUS_AWAITING_ORDER_NUMBER,
    normalize_order_number_from_speech,
    order_intent_detected,
    order_collection_prompt,
)
from app.agent_runtime.output_guardrails import apply_output_guardrails
from app.agent_runtime.yes_engagement import yes_engagement_reply
from app.dialogue.side_speech import is_side_conversation, side_speech_reply
from app.runtime.fast_classifier import classify
from app.safety.response_sanitizer import is_order_disclosure_text


def _session(**kwargs):
    defaults = {
        "order_flow_status": "idle",
        "commerce_flow_status": "idle",
        "twiml_greeting_spoken": False,
    }
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


def test_hello_question_instant_greeting():
    result = classify("Hello?", _session())
    assert result.action == "instant"
    assert result.skip_llm is True
    assert "SureShot" in result.instant_reply


def test_check_an_order_sets_awaiting_and_prompts():
    session = _session()
    result = classify("I'd like to check an order.", session)
    assert result.action == "instant"
    assert result.reason == "order_collection_prompt"
    assert session.order_flow_status == STATUS_AWAITING_ORDER_NUMBER
    assert "order number" in result.instant_reply.lower()


def test_sure_after_order_intent_asks_for_number():
    session = _session(order_flow_status=STATUS_AWAITING_ORDER_NUMBER)
    reply = yes_engagement_reply(session)
    assert reply is not None
    assert "order number" in reply.lower()


def test_order_number_preamble_extracts_spoken_digits():
    text = "I'd like to check on order number 4 7 9 8 0."
    assert normalize_order_number_from_speech(text) == "47980"
    assert order_intent_detected("I'd like to check an order.")


def test_side_speech_filters_meta_talk():
    assert is_side_conversation("See, he's all over the place, but yeah")
    assert side_speech_reply("Okay. Let's can we start all over?") is not None
    assert "start fresh" in side_speech_reply("start all over").lower()
    assert not is_side_conversation("I'd like to check an order.")


def test_order_disclosure_not_length_trimmed():
    long_reply = (
        "I found your order 47908. Payment status is paid. Fulfillment status is fulfilled. "
        "Subtotal 18.52 USD. Order total 20.38 USD. "
        "Items: Arkansas Farm National College Football, quantity 1. "
        "Email on file is jane at example dot com. Notes: delivered to facility. "
    ) * 4
    assert is_order_disclosure_text(long_reply)
    result = apply_output_guardrails(long_reply)
    assert "length_trimmed" not in result.reasons
    assert len(result.text.split()) >= 80


def test_order_flow_version():
    assert ORDER_FLOW_VERSION == "v4.56"


def test_order_collection_prompt_wording():
    prompt = order_collection_prompt()
    assert "order number" in prompt.lower()
