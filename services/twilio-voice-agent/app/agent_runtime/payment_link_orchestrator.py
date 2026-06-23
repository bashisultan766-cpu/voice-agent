"""Payment link orchestrator — checkout/email state machine (v4.14.5)."""
from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING, Any, Optional

from ..payment.safety import _mask_email, require_confirmed_cart, require_confirmed_email
from .cart_orchestrator import cart_summary_text
from .commerce_session import CommerceSession, cart_summary

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

PAYMENT_STATES = (
    "payment_requested",
    "cart_confirm_required",
    "email_capture_required",
    "email_spellback_required",
    "email_confirmed",
    "checkout_create_pending",
    "payment_link_sent",
    "failed",
    "escalated",
)

_SPOKEN_EMAIL_PAT = re.compile(
    r"\b([a-z0-9._%+\-\s]+)\s+at\s+([a-z0-9.\-\s]+)\s+dot\s+([a-z]{2,})\b",
    re.I,
)
_DIGIT_WORDS = {
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4",
    "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
}


def _short_sid(sid: str) -> str:
    return sid[:6] if sid else "?"


def _log_payment_state(sid: str, state: str) -> None:
    logger.info("payment_flow_state sid=%s state=%s", _short_sid(sid), state)


def parse_spoken_email(text: str) -> str | None:
    match = _SPOKEN_EMAIL_PAT.search(text.lower())
    if not match:
        return None
    local = match.group(1).strip().replace(" ", ".")
    domain = match.group(2).strip().replace(" ", ".")
    tld = match.group(3).strip()
    for word, digit in _DIGIT_WORDS.items():
        local = re.sub(rf"\b{word}\b", digit, local)
    email = f"{local}@{domain}.{tld}"
    if "@" in email and "." in email.split("@", 1)[1]:
        return email.lower()
    return None


def prepare_email_spellback(email: str, *, letter_by_letter: bool = False) -> str:
    masked = _mask_email(email)
    spoken_local = email.split("@", 1)[0].replace(".", " dot ")
    domain_part = email.split("@", 1)[1].replace(".", " dot ")
    heard = f"{spoken_local} at {domain_part}"
    logger.info("email_spellback_prepared sid=? masked_email=%s", masked)
    if letter_by_letter:
        parts = re.split(r"(\s+|@|\.)", heard)
        spelled = ", ".join(p.strip() for p in parts if p.strip())
        return spelled
    return f"I heard {heard}. Is that correct?"


def _cart_needs_customer_confirmation(session_state: Optional["SessionState"]) -> bool:
    if session_state is None:
        return True
    items = getattr(session_state, "cart_items", None) or []
    if not items:
        return True
    return any(str(i.get("confirmation_status", "")).lower() != "confirmed" for i in items)


def handle_payment_request(
    commerce: CommerceSession,
    *,
    session_state: Optional["SessionState"] = None,
    cart_confirmed: bool = False,
    email_confirmed: bool = False,
) -> dict[str, Any]:
    sid = commerce.sid
    summary = cart_summary(commerce)
    _log_payment_state(sid, "payment_requested")

    if summary["count"] == 0:
        candidates = [
            c for c in commerce.last_candidates
            if c.title and c.variant_id and c.availability != "out_of_stock"
        ]
        if candidates:
            titles = [c.title for c in candidates[:3]]
            joined = ", ".join(titles)
            _log_payment_state(sid, "cart_confirm_required")
            return {
                "response_mode": "direct_answer",
                "message": (
                    f"I found {joined}, but I haven't added them to your order yet. "
                    "Should I add them and prepare the payment link?"
                ),
                "expected_next": "confirm_add_candidates",
                "tool_categories": [],
            }
        _log_payment_state(sid, "failed")
        return {
            "response_mode": "direct_answer",
            "message": "Your order is empty right now. Tell me which book you'd like first.",
            "expected_next": "book_identifier",
            "tool_categories": [],
        }

    invalid_variant = any(not ln.variant_id for ln in summary["lines"])
    if invalid_variant:
        _log_payment_state(sid, "failed")
        return {
            "response_mode": "direct_answer",
            "message": "I need confirmed book listings before I can create a payment link.",
            "expected_next": "book_identifier",
            "tool_categories": [],
        }

    confirmed = cart_confirmed
    if session_state is not None:
        if _cart_needs_customer_confirmation(session_state) and not confirmed:
            _log_payment_state(sid, "cart_confirm_required")
            return {
                "response_mode": "direct_answer",
                "message": (
                    f"I have {summary['count']} books in your order: "
                    f"{', '.join(summary['titles'][:3])}. "
                    "Should I send the payment link for these?"
                ),
                "expected_next": "cart_confirm",
                "tool_categories": [],
            }
        cart_check = require_confirmed_cart(session_state)
        if not cart_check.allowed and not confirmed:
            _log_payment_state(sid, "cart_confirm_required")
            return {
                "response_mode": "direct_answer",
                "message": (
                    f"I have {summary['count']} books in your order: "
                    f"{', '.join(summary['titles'][:3])}. "
                    "Should I send the payment link for these?"
                ),
                "expected_next": "cart_confirm",
                "tool_categories": [],
            }

    email_ok = email_confirmed
    if session_state is not None:
        email_check = require_confirmed_email(session_state)
        email_ok = email_check.allowed
    if not email_ok:
        pending = getattr(session_state, "pending_email", "") if session_state else ""
        if pending:
            _log_payment_state(sid, "email_spellback_required")
            return {
                "response_mode": "direct_answer",
                "message": prepare_email_spellback(pending),
                "expected_next": "email_confirm",
                "tool_categories": [],
            }
        _log_payment_state(sid, "email_capture_required")
        return {
            "response_mode": "direct_answer",
            "message": "What email should I send the payment link to?",
            "expected_next": "email_capture",
            "tool_categories": [],
        }

    _log_payment_state(sid, "checkout_create_pending")
    return {
        "response_mode": "needs_tools",
        "message": None,
        "expected_next": "checkout_create",
        "tool_categories": ["payment_flow"],
    }


def payment_success_message(email: str, checkout_id: str = "") -> str:
    masked = _mask_email(email)
    if checkout_id:
        logger.info("payment_link_created sid=? checkout_id=%s url_masked=True", checkout_id[:8])
    logger.info("payment_link_email_sent sid=? masked_email=%s", masked)
    return (
        f"I sent the payment link to {masked}. When you open it, you can enter "
        "the facility and inmate details and complete the order."
    )


def assign_lines_to_group(
    commerce: CommerceSession,
    line_ids: list[str],
    *,
    group_id: str | None = None,
    name: str | None = None,
    email: str | None = None,
) -> dict[str, Any]:
    from .commerce_session import create_or_update_destination_group

    group = create_or_update_destination_group(
        commerce,
        group_id=group_id,
        name=name,
        email=email,
        cart_line_ids=line_ids,
    )
    for line in commerce.active_cart:
        if line.line_id in line_ids:
            line.destination_group_id = group.group_id
    titles = [ln.title for ln in commerce.active_cart if ln.line_id in line_ids and ln.status == "active"]
    return {
        "group_id": group.group_id,
        "titles": titles,
        "message": f"Got it. I'll keep those as a separate payment link for {', '.join(titles[:3])}.",
    }


def multi_group_summary(commerce: CommerceSession) -> str | None:
    groups = [g for g in commerce.destination_groups if g.cart_line_ids]
    if len(groups) < 2:
        return None
    parts = []
    for g in groups:
        titles = [
            ln.title for ln in commerce.active_cart
            if ln.line_id in g.cart_line_ids and ln.status == "active"
        ]
        label = g.name or f"group {g.group_id[:4]}"
        parts.append(f"one for {label} ({', '.join(titles[:2])})")
    return f"Got it. I'll keep those as two separate payment links: {' and '.join(parts)}."
