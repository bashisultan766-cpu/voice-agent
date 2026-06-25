"""
Instant greeting replies — skip OpenAI on hello/how-are-you (v4.29).

Twilio already speaks the TwiML welcome; this answers follow-up greetings
in under a second without a full LLM round-trip.
"""
from __future__ import annotations

import re
from typing import Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from ..state.models import SessionState

_GREETING_PAT = re.compile(
    r"^\s*(hi|hello|hey|hiya|good morning|good afternoon|good evening|"
    r"how are you|how'?s it going|how are you doing|what'?s up|sup|"
    r"how do you do)\b",
    re.I,
)
_HOW_ARE_YOU_PAT = re.compile(r"\bhow are you\b|\bhow'?s it going\b", re.I)


def is_fast_greeting_turn(text: str, *, turn_count: int = 0) -> bool:
    t = (text or "").strip()
    if not t or turn_count > 4:
        return False
    if len(t.split()) > 14:
        return False
    return bool(_GREETING_PAT.search(t))


def _greeting_safe_name(name: str) -> str:
    n = (name or "").strip()
    if not n or len(n.split()) > 4:
        return ""
    if "?" in n or re.search(r"\b(saying that|how are you|what can i)\b", n, re.I):
        return ""
    return n


def fast_greeting_reply(session: "SessionState", caller_text: str) -> Optional[str]:
    """Deterministic greeting — no tools, no OpenAI."""
    if not is_fast_greeting_turn(caller_text, turn_count=getattr(session, "turn_count", 0)):
        return None

    from ..dialogue.greeting import GREETING_AFTER_TWIML, build_first_response_greeting

    greeted = bool(getattr(session, "twiml_greeting_spoken", False))
    name = _greeting_safe_name(getattr(session, "caller_name", "") or "")

    if _HOW_ARE_YOU_PAT.search(caller_text):
        if name:
            tail = f"What can I help you with today, {name}?"
        elif greeted:
            tail = GREETING_AFTER_TWIML
        else:
            tail = "What can I help you with today?"
        return f"Hey! I'm doing well, thanks for asking. {tail}"

    return build_first_response_greeting(session, greeted)
