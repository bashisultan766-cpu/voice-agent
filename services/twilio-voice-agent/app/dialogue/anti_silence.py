"""Anti-silence — never leave the caller waiting without a spoken reply."""
from __future__ import annotations

import re
from typing import Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from ..state.models import SessionState

_SILENCE_FRUSTRATION_PAT = re.compile(
    r"\b("
    r"why are you|why you|keep silence|keep quiet|not talking|not responding|"
    r"not continue|not asking|are you there|hello\?|you there|"
    r"why this silence|why are you silent|can you hear me"
    r")\b",
    re.I,
)


def caller_needs_presence_reply(text: str) -> bool:
    return bool(_SILENCE_FRUSTRATION_PAT.search((text or "").strip()))


def anti_silence_reply(session: "SessionState", caller_text: str) -> Optional[str]:
    """
    Deterministic reply when the caller thinks the agent went quiet.
    Returns None when the utterance is not a silence/frustration complaint.
    """
    text = (caller_text or "").strip()
    if not text:
        return None

    from .naturalness import NaturalnessController

    if not caller_needs_presence_reply(text) and not NaturalnessController.detect_frustration(text):
        return None

    NaturalnessController.apply_frustration(session, text)

    if NaturalnessController.detect_already_gave(text):
        return NaturalnessController.frustration_repair_message(session)

    from ..agent_runtime.commerce_flow_state import (
        STATUS_AWAITING_QUANTITY,
        STATUS_AWAITING_ADD_CONFIRM,
        STATUS_AWAITING_ANOTHER_BOOK,
        _candidate,
        _status,
        quantity_prompt,
    )

    status = _status(session)
    candidate = _candidate(session)
    if status == STATUS_AWAITING_QUANTITY and candidate:
        return f"I'm here — sorry about the pause. {quantity_prompt(candidate)}"
    if status == STATUS_AWAITING_ADD_CONFIRM and candidate:
        qty = int(getattr(session, "commerce_pending_quantity", 0) or 1)
        short = (candidate.get("title") or "that book")[:60]
        copy_phrase = "one copy" if qty == 1 else f"{qty} copies"
        return (
            f"I'm here — sorry about that. Shall I add {copy_phrase} of {short}? "
            "Just say yes."
        )
    if status == STATUS_AWAITING_ANOTHER_BOOK:
        return (
            "I'm right here — sorry for the pause. "
            "What's the next ISBN or title you'd like to add?"
        )

    from ..agent_runtime.yes_engagement import yes_engagement_fallback

    return yes_engagement_fallback(session)
