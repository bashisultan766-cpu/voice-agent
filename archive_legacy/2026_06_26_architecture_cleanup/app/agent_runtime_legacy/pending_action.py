"""
Pending-action tracking for natural confirmation flows (v4.17).

When the agent offers to do something ("Want me to send the payment link?")
the offered action is stored as a *pending action*. A later bare "yes" then
executes that pending action instead of being treated as unknown small-talk.

Also provides robust affirmative/negative detection for short replies.
"""
from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

# Bare confirmations. Anchored so "yes but actually no" is not a clean yes.
# Allows up to two affirmative phrases ("sure, go ahead").
_AFFIRM_WORD = (
    r"(?:yes please|yes|yep|yeah|yup|sure|ok|okay|okey|please do|please|"
    r"go ahead|go for it|do it|send it|sounds good|that works|that's right|"
    r"that is right|correct|right|absolutely|definitely|affirmative|uh-?huh|mm-?hmm)"
)
_AFFIRM_PAT = re.compile(
    rf"^\s*{_AFFIRM_WORD}(?:\s*[,]?\s+{_AFFIRM_WORD})?\s*[.!]*\s*$",
    re.IGNORECASE,
)
_NEGATE_WORD = (
    r"(?:no thank you|no thanks|not now|not yet|never mind|hold on|"
    r"no|nope|nah|don'?t|do not|cancel|stop|wait|negative)"
)
_NEGATE_PAT = re.compile(
    rf"^\s*{_NEGATE_WORD}(?:\s*[,]?\s+{_NEGATE_WORD})?\s*[.!]*\s*$",
    re.IGNORECASE,
)

# How long a pending action stays valid (seconds).
_PENDING_TTL = 180.0


@dataclass
class PendingAction:
    action: str                       # e.g. "send_payment_link", "collect_isbn"
    payload: dict[str, Any] = field(default_factory=dict)
    prompt: str = ""                  # what we offered, for diagnostics
    created_at: float = field(default_factory=time.monotonic)

    def is_expired(self, now: Optional[float] = None) -> bool:
        return (now or time.monotonic()) - self.created_at > _PENDING_TTL


def is_affirmative(text: str) -> bool:
    return bool(_AFFIRM_PAT.match((text or "").strip()))


def is_negative(text: str) -> bool:
    return bool(_NEGATE_PAT.match((text or "").strip()))


def set_pending_action(
    session: "SessionState",
    action: str,
    *,
    payload: Optional[dict[str, Any]] = None,
    prompt: str = "",
) -> None:
    pending = PendingAction(action=action, payload=payload or {}, prompt=prompt)
    try:
        session.pending_action = pending
    except Exception:  # noqa: BLE001 — session may use __slots__
        setattr(session, "_pending_action", pending)
    logger.info(
        "pending_action_set sid=%s action=%s",
        getattr(session, "call_sid", "")[:6], action,
    )


def get_pending_action(session: "SessionState") -> Optional[PendingAction]:
    pending = getattr(session, "pending_action", None) or getattr(session, "_pending_action", None)
    if pending is None:
        return None
    if isinstance(pending, dict):  # rehydrated from a store
        pending = PendingAction(
            action=pending.get("action", ""),
            payload=pending.get("payload", {}),
            prompt=pending.get("prompt", ""),
        )
    if not isinstance(pending, PendingAction) or not pending.action:
        return None
    if pending.is_expired():
        clear_pending_action(session)
        return None
    return pending


def clear_pending_action(session: "SessionState") -> None:
    for attr in ("pending_action", "_pending_action"):
        try:
            if getattr(session, attr, None) is not None:
                setattr(session, attr, None)
        except Exception:  # noqa: BLE001
            pass


def consume_if_affirmative(session: "SessionState", text: str) -> Optional[PendingAction]:
    """
    If there is a valid pending action and the caller affirmed, return and
    clear it. If the caller declined, clear it and return None.
    """
    pending = get_pending_action(session)
    if pending is None:
        return None
    if is_negative(text):
        logger.info(
            "pending_action_declined sid=%s action=%s",
            getattr(session, "call_sid", "")[:6], pending.action,
        )
        clear_pending_action(session)
        return None
    if is_affirmative(text):
        logger.info(
            "pending_action_confirmed sid=%s action=%s",
            getattr(session, "call_sid", "")[:6], pending.action,
        )
        clear_pending_action(session)
        return pending
    return None
