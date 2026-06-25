"""
Bare "yes" engagement — agent must never go silent after yes (v4.27).
"""
from __future__ import annotations

import re
from typing import Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from ..state.models import SessionState

_BARE_YES_PAT = re.compile(
    r"^\s*(yes|yeah|yep|yup|sure|ok|okay|right|correct|absolutely|go ahead)\s*[.!]*\s*$",
    re.I,
)


def is_bare_yes(text: str) -> bool:
    return bool(_BARE_YES_PAT.match((text or "").strip()))


def yes_engagement_reply(session: "SessionState") -> Optional[str]:
    """
    Return a deterministic continue-the-conversation reply for bare yes,
    or None if another handler should take it.
    """
    from .commerce_flow_state import (
        STATUS_AWAITING_ADD_CONFIRM,
        STATUS_AWAITING_ANOTHER_BOOK,
        STATUS_AWAITING_BOOK_CONFIRM,
        STATUS_AWAITING_EMAIL_COLLECTION,
        STATUS_AWAITING_QUANTITY,
        _candidate,
        _resolve_pending_candidate,
        _status,
        add_confirm_prompt,
        cart_summary_and_email_prompt,
        next_book_prompt,
        quantity_prompt,
    )

    text_status = _status(session)
    candidate = _resolve_pending_candidate(session)

    if getattr(session, "awaiting_payment_email_confirmation", False):
        return None

    if getattr(session, "awaiting_payment_email", False) or text_status == STATUS_AWAITING_EMAIL_COLLECTION:
        if not getattr(session, "pending_payment_email", "") and not getattr(session, "confirmed_email", ""):
            from ..payment.payment_prompts import payment_email_collection_prompt

            return payment_email_collection_prompt()

    if text_status == STATUS_AWAITING_QUANTITY and candidate:
        return None

    if text_status == STATUS_AWAITING_ADD_CONFIRM and candidate:
        return None

    if text_status == STATUS_AWAITING_BOOK_CONFIRM and candidate:
        return quantity_prompt(candidate)

    if text_status == STATUS_AWAITING_ANOTHER_BOOK:
        return next_book_prompt()

    if text_status == STATUS_AWAITING_EMAIL_COLLECTION and not getattr(session, "pending_payment_email", ""):
        return cart_summary_and_email_prompt(session)

    return (
        "Yes, got it. How can I help you next — another book, or should we "
        "send your payment link?"
    )
