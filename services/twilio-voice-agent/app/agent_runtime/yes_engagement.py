"""
Bare "yes" engagement — agent must never go silent after yes (v4.32).
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


def yes_engagement_fallback(session: "SessionState") -> str:
    """Always speak something — never leave the caller waiting after bare yes/okay."""
    from .order_flow_state import STATUS_AWAITING_ORDER_NUMBER, STATUS_AWAITING_ORDER_VERIFICATION

    order_status = getattr(session, "order_flow_status", "") or ""
    if order_status == STATUS_AWAITING_ORDER_NUMBER:
        return "Sure — please read your order number when you're ready."
    if order_status == STATUS_AWAITING_ORDER_VERIFICATION:
        return (
            "Thanks. Please confirm the email or phone number on the order "
            "so I can pull up the details."
        )
    if getattr(session, "pending_isbn_buffer", ""):
        return "Go ahead with the rest of the ISBN digits whenever you're ready."
    return (
        "Sure! I can help you find a book, check an order, or send a payment link. "
        "What would you like to do?"
    )


def _complete_pending_add(session: "SessionState") -> Optional[str]:
    from ..voice.title_speech import spoken_book_title
    from .commerce_flow_state import (
        STATUS_AWAITING_ADD_CONFIRM,
        _resolve_pending_candidate,
        _status,
        add_staged_book_to_cart,
        another_book_after_add_prompt,
    )

    if _status(session) != STATUS_AWAITING_ADD_CONFIRM:
        return None
    candidate = _resolve_pending_candidate(session)
    if not candidate:
        return None
    qty = int(getattr(session, "commerce_pending_quantity", 0) or 1)
    title = add_staged_book_to_cart(session, quantity=qty)
    if not title:
        return None
    copy_phrase = "one copy" if qty == 1 else f"{qty} copies"
    short = spoken_book_title(title)
    return f"Got it — added {copy_phrase} of {short}. {another_book_after_add_prompt()}"


def yes_engagement_reply(session: "SessionState") -> Optional[str]:
    """
    Return a deterministic continue-the-conversation reply for bare yes.
    Falls back to ``yes_engagement_fallback`` — never returns None for bare yes.
    """
    from .commerce_flow_state import (
        STATUS_AWAITING_ANOTHER_BOOK,
        STATUS_AWAITING_BOOK_CONFIRM,
        STATUS_AWAITING_EMAIL_COLLECTION,
        STATUS_AWAITING_QUANTITY,
        _candidate,
        _resolve_pending_candidate,
        _status,
        add_confirm_prompt,
        cart_summary_and_email_prompt,
        commerce_flow_active,
        next_book_prompt,
        quantity_prompt,
    )

    added = _complete_pending_add(session)
    if added:
        return added

    text_status = _status(session)
    candidate = _resolve_pending_candidate(session)

    if getattr(session, "awaiting_payment_email_confirmation", False):
        return yes_engagement_fallback(session)

    if getattr(session, "awaiting_payment_email", False) or text_status == STATUS_AWAITING_EMAIL_COLLECTION:
        if not getattr(session, "pending_payment_email", "") and not getattr(session, "confirmed_email", ""):
            from ..payment.payment_prompts import payment_email_collection_prompt

            return payment_email_collection_prompt()

    from .payment_flow_state import _cart_has_confirmed_items

    if not commerce_flow_active(session) and not _cart_has_confirmed_items(session):
        return yes_engagement_fallback(session)

    if text_status == STATUS_AWAITING_QUANTITY and candidate:
        return quantity_prompt(candidate)

    if text_status == STATUS_AWAITING_BOOK_CONFIRM and candidate:
        return quantity_prompt(candidate)

    if text_status == STATUS_AWAITING_ANOTHER_BOOK:
        session.pending_isbn_buffer = ""
        return next_book_prompt()

    if text_status == STATUS_AWAITING_EMAIL_COLLECTION and not getattr(session, "pending_payment_email", ""):
        return cart_summary_and_email_prompt(session)

    return (
        "Yes, got it. How can I help you next — another book, or should we "
        "send your payment link?"
    )
