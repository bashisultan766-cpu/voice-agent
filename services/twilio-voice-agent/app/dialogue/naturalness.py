"""NaturalnessController — human voice tone v2 (v4.6)."""
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
        "Customer is frustrated — one brief apology, then state facts and next step. "
        "Do not repeat long explanations."
    ),
    "correction_mode": "Customer is correcting — acknowledge and fix.",
    "payment_mode": "Payment flow — state exactly what is missing or confirm send.",
    "sales_mode": "Sales flow — one book at a time, offer another or payment.",
    "repair_mode": (
        "Customer says they already gave info — acknowledge, summarize what you have, "
        "and use it without asking again."
    ),
}

_WARM_ACKS = ("Got it.", "Perfect.", "No problem.", "Thanks, I have that.")

_FRUSTRATION_REPAIR = (
    "You're right — sorry about that. I have the books you gave me. Let me use those."
)

_ALREADY_GAVE_RE = re.compile(
    r"\b(i already (gave|told|said)|i sent you|how many times|"
    r"you already have|i already gave you)\b",
    re.IGNORECASE,
)

_MAX_NORMAL_WORDS = 25
_MAX_EXPLAIN_WORDS = 50


@dataclass
class NaturalnessState:
    phrase_counts: dict[str, int] = field(default_factory=dict)
    recent_phrases: list[str] = field(default_factory=list)
    style_mode: str = "normal"
    apology_count: int = 0
    turn_apology_used: bool = False


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
        if re.search(r"\b(sorry|apologize|apologies)\b", lower):
            state.apology_count += 1
        state.turn_apology_used = False
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
            limit = 1 if key == "let me check" else 2
            if count >= limit and key in state.recent_phrases[-5:]:
                alts = _STOCK_PHRASES.get(key, [])
                alt_hint = f" use '{alts[0]}'" if alts else ""
                notes.append(f"Do not say '{key}' again;{alt_hint}.")
        if state.apology_count >= 3:
            notes.append("Do not apologize again this call unless customer is still upset.")
        notes.append(
            f"Keep reply under {_MAX_NORMAL_WORDS} words unless explaining cart or payment."
        )
        return " ".join(notes)

    @classmethod
    def detect_frustration(cls, text: str) -> bool:
        return bool(re.search(
            r"\b(no no|wrong|not correct|why are you not|hello\?|you are not|"
            r"again again|wait wait|i already told you|how many times|this is wrong|"
            r"that's wrong|frustrated|annoyed)\b",
            text,
            re.IGNORECASE,
        ))

    @classmethod
    def detect_already_gave(cls, text: str) -> bool:
        return bool(_ALREADY_GAVE_RE.search(text))

    @classmethod
    def apply_frustration(cls, session, text: str) -> None:
        if cls.detect_frustration(text):
            cls.set_style(session, "frustrated_customer")
            if getattr(session, "dialogue", None):
                session.dialogue.customer_mood = "frustrated"
        if cls.detect_already_gave(text):
            cls.set_style(session, "repair_mode")

    @classmethod
    def frustration_repair_message(cls, session) -> str:
        """Deterministic repair when customer says they already gave info."""
        try:
            from ..cart.session import get_ledger
            ledger = get_ledger(session)
            n = ledger.confirmed_count()
            isbn_n = len(getattr(session, "isbn_history", []) or [])
            if n or isbn_n:
                return _FRUSTRATION_REPAIR
        except Exception:
            pass
        return "I understand. Let me slow down and fix this."

    @classmethod
    def should_include_apology(cls, session) -> bool:
        state = cls.get_state(session)
        if state.turn_apology_used:
            return False
        if state.apology_count >= 2:
            return False
        return True

    @classmethod
    def mark_apology_used(cls, session) -> None:
        state = cls.get_state(session)
        state.turn_apology_used = True
        state.apology_count += 1
        cls.set_state(session, state)

    @classmethod
    def word_count_ok(cls, text: str, explaining: bool = False) -> bool:
        limit = _MAX_EXPLAIN_WORDS if explaining else _MAX_NORMAL_WORDS
        return len(text.split()) <= limit
