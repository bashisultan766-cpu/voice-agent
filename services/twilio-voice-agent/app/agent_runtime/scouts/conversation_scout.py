"""Conversation signal scout — greetings, identity, presence (v4.16.0)."""
from __future__ import annotations

import re
import uuid

from ..speculative_prefetch_manager import PrefetchResult

_GREETING_PAT = re.compile(
    r"\b(hello|hi|hey|how are you|how are ya|are you there|can you hear me|"
    r"your name is eric|thanks|thank you|okay|ok|not using llm|why are you not)\b",
    re.I,
)
_SIGNAL_MAP = (
    (re.compile(r"\bhello\b", re.I), "greeting"),
    (re.compile(r"\bhow are you\b", re.I), "how_are_you"),
    (re.compile(r"\bare you there\b|\bhello\?\b", re.I), "presence_check"),
    (re.compile(r"\bcan you hear me\b", re.I), "hear_check"),
    (re.compile(r"\byour name is eric\b", re.I), "identity_confirmation"),
    (re.compile(r"\b(?:remember|do you remember)\b", re.I), "memory_question"),
    (re.compile(r"\b(?:not using llm|why are you not)\b", re.I), "meta_complaint"),
    (re.compile(r"\b(?:thanks|thank you)\b", re.I), "thanks"),
)


async def run_scout(*, user_text: str, **_) -> PrefetchResult | None:
    text = (user_text or "").strip()
    if not text or not _GREETING_PAT.search(text):
        return None
    signal = "conversation"
    for pat, name in _SIGNAL_MAP:
        if pat.search(text):
            signal = name
            break
    return PrefetchResult(
        result_id=str(uuid.uuid4())[:12],
        scout_name="conversation_scout",
        kind="conversation_signal",
        confidence=0.95 if signal != "conversation" else 0.7,
        entities={"signal": signal, "text": text},
        facts={"is_greeting": signal in ("greeting", "how_are_you", "presence_check", "hear_check")},
        source="conversation_scout",
        safe_for_llm=True,
    )
