"""SureShot Books greeting text — deterministic, no LLM (v4.6)."""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..state.models import SessionState

GREETING_NEW = "Hello! Thank you for calling SureShot Books. How can I help you today?"
GREETING_RETURNING = "Hello, welcome back to SureShot Books. How can I help you today?"
GREETING_RETURNING_NAMED = (
    "Hello, welcome back to SureShot Books, {name}. How can I help you today?"
)
GREETING_AFTER_TWIML = "Sure. What can I help you with today?"

_FORBIDDEN_GREETING_WORDS = (
    "ai",
    "virtual assistant",
    "powered by",
    "let me check",
)


def build_twiml_greeting(returning: bool = False, caller_name: str = "") -> str:
    """Greeting spoken by Twilio ConversationRelay before WebSocket setup."""
    from ..config import get_settings

    s = get_settings()
    base = (s.VOICE_WELCOME_GREETING or GREETING_NEW).strip()
    if returning:
        if caller_name:
            name = caller_name.strip()
            if name:
                return (
                    f"Hello! Welcome back to SureShot Books, {name}. "
                    "How can I help you today?"
                )
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
        name = (session.caller_name or "").strip()
        if name:
            return GREETING_RETURNING_NAMED.format(name=name)
        return GREETING_RETURNING

    return GREETING_NEW


def greeting_word_count(text: str) -> int:
    return len(text.split())


def greeting_has_forbidden_phrases(text: str) -> bool:
    lower = text.lower()
    return any(word in lower for word in _FORBIDDEN_GREETING_WORDS)
