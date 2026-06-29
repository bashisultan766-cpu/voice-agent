"""SureShot Books greeting text — deterministic, no LLM (v4.6)."""
from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..state.models import SessionState

GREETING_NEW = "This is SureShot Books. How can I help you today?"
GREETING_RETURNING = "Welcome back to SureShot Books. How can I help you today?"
GREETING_RETURNING_NAMED = (
    "Welcome back to SureShot Books, {name}. How can I help you today?"
)
GREETING_AFTER_TWIML = "What can I help you with today?"

_FORBIDDEN_GREETING_WORDS = (
    "ai",
    "virtual assistant",
    "powered by",
    "let me check",
)

_GARBAGE_NAME_WORDS = frozenset({
    "saying",
    "yeah",
    "yes",
    "okay",
    "ok",
    "hi",
    "hello",
    "thanks",
    "thank",
    "caller",
    "customer",
    "unknown",
    "there",
    "here",
    "correct",
    "right",
})


def greeting_safe_name(name: str) -> str:
    """Reject STT garbage or question fragments masquerading as a caller name."""
    n = (name or "").strip()
    if not n or len(n.split()) > 4:
        return ""
    if "?" in n or re.search(
        r"\b(saying that|how are you|what can i|thank you for calling|sureshot)\b",
        n,
        re.I,
    ):
        return ""
    first = n.split()[0].lower().rstrip(".,!?")
    if first in _GARBAGE_NAME_WORDS:
        return ""
    return n


def build_twiml_greeting(returning: bool = False, caller_name: str = "") -> str:
    """Greeting spoken by Twilio ConversationRelay before WebSocket setup."""
    from ..config import get_settings

    s = get_settings()
    base = (s.VOICE_WELCOME_GREETING or GREETING_NEW).strip()
    if returning:
        name = greeting_safe_name(caller_name)
        if name:
            return GREETING_RETURNING_NAMED.format(name=name)
        return GREETING_RETURNING
    return base


def build_resume_twiml_greeting() -> str:
    """Resume greeting when caller reconnects within the resume window."""
    return "I'm sorry about that. Let me continue from where we left off."


def build_first_response_greeting(session: "SessionState", greeted_already: bool) -> str:
    """
    First assistant reply when the caller opens with hi/hello.

    If TwiML or WS already greeted, avoid repeating the full welcome.
    """
    if greeted_already:
        return GREETING_AFTER_TWIML

    if session.is_returning_caller:
        name = greeting_safe_name(getattr(session, "caller_name", "") or "")
        if name:
            return GREETING_RETURNING_NAMED.format(name=name)
        return GREETING_RETURNING

    return GREETING_NEW


def greeting_word_count(text: str) -> int:
    return len(text.split())


def greeting_has_forbidden_phrases(text: str) -> bool:
    lower = text.lower()
    return any(word in lower for word in _FORBIDDEN_GREETING_WORDS)
