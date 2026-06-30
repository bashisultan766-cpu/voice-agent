"""
Voice Output Contract — strict structured shape for all speech before formatting/TTS.

Every handler/LLM string is normalized to:

{
  "type": "voice_response",
  "content": string (max 2 sentences),
  "intent": "answer" | "ask" | "confirm" | "close"
}
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Any, Literal

logger = logging.getLogger(__name__)

VoiceIntent = Literal["answer", "ask", "confirm", "close"]

_VALID_INTENTS = frozenset({"answer", "ask", "confirm", "close"})
_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*([\s\S]*?)```", re.I)
_REASONING_BLOCK_RE = re.compile(r"<think(?:ing)?>.*?</think(?:ing)?>", re.I | re.S)


@dataclass(frozen=True)
class VoiceOutputContract:
    type: str
    content: str
    intent: VoiceIntent
    repaired: bool = False


def _split_sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+", (text or "").strip())
    return [part.strip() for part in parts if part.strip()]


def trim_to_two_sentences(text: str) -> str:
    sentences = _split_sentences(text)
    if not sentences:
        return (text or "").strip()
    return " ".join(sentences[:2]).strip()


def _infer_intent(text: str) -> VoiceIntent:
    from .voice_response_formatter import _infer_next_action

    return _infer_next_action(text)


def _strip_non_speech_artifacts(text: str) -> str:
    cleaned = (text or "").strip()
    cleaned = _REASONING_BLOCK_RE.sub(" ", cleaned)
    cleaned = _JSON_FENCE_RE.sub(" ", cleaned)
    return re.sub(r"\s{2,}", " ", cleaned).strip()


def _try_parse_json(raw: str) -> Any | None:
    text = (raw or "").strip()
    if not text:
        return None

    fence = _JSON_FENCE_RE.search(text)
    if fence:
        text = fence.group(1).strip()

    candidates = [text]
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        candidates.append(text[start : end + 1])

    for candidate in candidates:
        if not candidate.startswith("{"):
            continue
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    return None


def _contract_from_dict(data: dict[str, Any], *, repaired: bool) -> VoiceOutputContract | None:
    content = (
        data.get("content")
        or data.get("speech_text")
        or data.get("message")
        or data.get("say")
        or ""
    )
    content = trim_to_two_sentences(str(content).strip())
    if not content:
        return None

    intent_raw = str(data.get("intent") or data.get("next_action") or "").lower().strip()
    intent: VoiceIntent
    if intent_raw in _VALID_INTENTS:
        intent = intent_raw  # type: ignore[assignment]
    else:
        intent = _infer_intent(content)
        repaired = True

    declared_type = str(data.get("type") or "").strip()
    if declared_type and declared_type != "voice_response":
        repaired = True

    return VoiceOutputContract(
        type="voice_response",
        content=content,
        intent=intent,
        repaired=repaired,
    )


def repair_voice_output(raw: str) -> VoiceOutputContract:
    """Wrap plain or partial text into a valid voice response contract."""
    content = trim_to_two_sentences(_strip_non_speech_artifacts(raw))
    if not content:
        content = "How can I help you with SureShot Books today?"
    return VoiceOutputContract(
        type="voice_response",
        content=content,
        intent=_infer_intent(content),
        repaired=True,
    )


def enforce_voice_output_contract(raw: str) -> VoiceOutputContract:
    """
    Parse strict voice JSON or auto-repair unstructured LLM/handler text.
    Never returns empty content.
    """
    parsed = _try_parse_json(raw)
    if isinstance(parsed, dict):
        contract = _contract_from_dict(parsed, repaired=False)
        if contract:
            if contract.repaired:
                logger.info(
                    "voice_output_contract_repaired intent=%s chars=%d",
                    contract.intent,
                    len(contract.content),
                )
            return contract

    contract = repair_voice_output(raw)
    logger.info(
        "voice_output_contract_repaired intent=%s chars=%d",
        contract.intent,
        len(contract.content),
    )
    return contract
