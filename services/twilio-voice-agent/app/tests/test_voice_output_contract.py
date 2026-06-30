"""Voice Output Contract — structured speech before formatting/TTS."""
from __future__ import annotations

import json

from app.voice.voice_output_contract import (
    enforce_voice_output_contract,
    repair_voice_output,
    trim_to_two_sentences,
)
from app.runtime.voice_commerce_runtime import VoiceCommerceRuntime


def test_parses_valid_voice_json():
    raw = json.dumps({
        "type": "voice_response",
        "content": "Your order shipped yesterday.",
        "intent": "answer",
    })
    contract = enforce_voice_output_contract(raw)
    assert contract.repaired is False
    assert contract.type == "voice_response"
    assert contract.content == "Your order shipped yesterday."
    assert contract.intent == "answer"


def test_repairs_plain_llm_text():
    raw = (
        "Here is a long unstructured answer with extra detail. "
        "Another sentence follows. A third should be dropped."
    )
    contract = enforce_voice_output_contract(raw)
    assert contract.repaired is True
    assert contract.type == "voice_response"
    assert contract.content.count(".") + contract.content.count("!") <= 2
    assert "third" not in contract.content.lower()


def test_repairs_invalid_json_to_contract():
    contract = repair_voice_output("   ")
    assert contract.type == "voice_response"
    assert contract.content
    assert contract.intent in ("answer", "ask", "confirm", "close")


def test_trim_to_two_sentences():
    assert trim_to_two_sentences("One. Two. Three.") == "One. Two."


def test_pipeline_never_returns_raw_unstructured():
    paced = VoiceCommerceRuntime._apply_voice_output_pipeline(
        "First idea here. Second idea here. Third idea dropped."
    )
    assert "Third idea" not in paced
    assert paced


def test_format_for_tts_skips_contract_for_email_readback():
    readback = "Just to confirm, I heard john at gmail dot com."
    assert VoiceCommerceRuntime._format_for_tts(readback) == readback
