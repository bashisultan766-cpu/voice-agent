"""NaturalnessController — reduce robotic repetition (v4.4)."""
from __future__ import annotations

import re
from dataclasses import dataclass, field

_STOCK_PHRASES = {
    "let me check": ["One moment.", "Give me just a second.", "I'll look that up."],
    "just to confirm": ["To double-check,", "Quick confirmation —"],
    "i can help": ["Sure.", "Of course.", "Happy to help."],
    "sure": ["Okay.", "Got it."],
}

_STYLE_HINTS = {
    "normal": "",
    "confused_customer": "Customer seems confused — use one simple question.",
    "frustrated_customer": (
        "Customer is frustrated — brief apology once, then state facts and next step. "
        "Do not repeat long explanations."
    ),
    "correction_mode": "Customer is correcting — acknowledge and fix.",
    "payment_mode": "Payment flow — state exactly what is missing or confirm send.",
    "sales_mode": "Sales flow — one book at a time, offer another or payment.",
}


@dataclass
class NaturalnessState:
    phrase_counts: dict[str, int] = field(default_factory=dict)
    recent_phrases: list[str] = field(default_factory=list)
    style_mode: str = "normal"
    apology_given: bool = False


class NaturalnessController:
    @staticmethod
    def get_state(session) -> NaturalnessState:
        raw = getattr(session, "naturalness", None)
        if isinstance(raw, NaturalnessState):
            return raw
        return NaturalnessState()

    @staticmethod
    def set_state(session, state: NaturalnessState) -> None:
        session.naturalness = state

    @classmethod
    def record_response(cls, session, text: str) -> None:
        state = cls.get_state(session)
        lower = text.lower()
        for key in _STOCK_PHRASES:
            if key in lower:
                state.phrase_counts[key] = state.phrase_counts.get(key, 0) + 1
                state.recent_phrases.append(key)
                if len(state.recent_phrases) > 10:
                    state.recent_phrases = state.recent_phrases[-10:]
        cls.set_state(session, state)

    @classmethod
    def style_hint(cls, session) -> str:
        state = cls.get_state(session)
        return _STYLE_HINTS.get(state.style_mode, "")

    @classmethod
    def set_style(cls, session, mode: str) -> None:
        state = cls.get_state(session)
        state.style_mode = mode
        cls.set_state(session, state)

    @classmethod
    def avoid_repetition_note(cls, session) -> str:
        state = cls.get_state(session)
        notes: list[str] = []
        for key, count in state.phrase_counts.items():
            if count >= 2 and key in state.recent_phrases[-5:]:
                notes.append(f"Do not say '{key}' again; use a fresh phrase.")
        return " ".join(notes)

    @classmethod
    def detect_frustration(cls, text: str) -> bool:
        return bool(re.search(
            r"\b(no no|wrong|not correct|why are you not|hello\?|you are not|"
            r"again again|wait wait|i already told you|how many times|this is wrong|"
            r"that's wrong)\b",
            text,
            re.IGNORECASE,
        ))

    @classmethod
    def apply_frustration(cls, session, text: str) -> None:
        if cls.detect_frustration(text):
            cls.set_style(session, "frustrated_customer")
            if getattr(session, "dialogue", None):
                session.dialogue.customer_mood = "frustrated"
