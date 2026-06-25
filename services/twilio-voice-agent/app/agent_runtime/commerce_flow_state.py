"""
Multi-book commerce flow for the LLM runtime (v4.24).

Deterministic sales steps on CartLedger:
  search → confirm each book → add → another book? → no → cart summary + email

Email capture / payment send remain in payment_flow_state (v4.23).
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Any, Optional, TYPE_CHECKING

from .payment_flow_state import PaymentGateResult, _cart_has_confirmed_items, build_payment_tool_result

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

COMMERCE_FLOW_VERSION = "v4.24"

STATUS_IDLE = "idle"
STATUS_AWAITING_BOOK_CONFIRM = "awaiting_book_confirm"
STATUS_AWAITING_ANOTHER_BOOK = "awaiting_another_book"
STATUS_AWAITING_EMAIL_COLLECTION = "awaiting_email_collection"

_AFFIRM_PAT = re.compile(
    r"^\s*(yes|yeah|yep|yup|sure|ok|okay|correct|right|please do|go ahead|"
    r"that.?s right|sounds good|absolutely|do it|add it|add this|take it|"
    r"i.?ll take (?:it|this|that)|yes please)\s*[.!]*\s*$",
    re.IGNORECASE,
)
_NEGATE_PAT = re.compile(
    r"^\s*(no|nope|nah|not now|not yet|no thanks|no thank you|that.?s all|"
    r"i.?m good|nothing else|no more|no more books)\s*[.!]*\s*$",
    re.IGNORECASE,
)
_AFFIRM_LOOSE_PAT = re.compile(
    r"^\s*(yes|yeah|yep|yup|sure|ok|okay)\b.*\b(right|correct)\b",
    re.IGNORECASE,
)


def _is_affirmative(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return False
    return bool(_AFFIRM_PAT.match(t) or _AFFIRM_LOOSE_PAT.match(t))


_ANOTHER_PAT = re.compile(
    r"\b(another (?:one|book)|i need another|i want another|one more book|"
    r"next book|a different book|look up another|find another)\b",
    re.IGNORECASE,
)


@dataclass
class CommerceTurnHint:
    force_reply: Optional[str] = None
    book_added: bool = False


def _status(session: "SessionState") -> str:
    return getattr(session, "commerce_flow_status", STATUS_IDLE) or STATUS_IDLE


def _candidate(session: "SessionState") -> dict[str, Any]:
    return dict(getattr(session, "commerce_pending_candidate", None) or {})


def _title(product: dict[str, Any]) -> str:
    return (product.get("title") or product.get("name") or "that book").strip()


def _price_phrase(product: dict[str, Any]) -> str:
    price = (product.get("price") or "").strip()
    if price and price.upper() != "N/A":
        return f"It's {price}."
    return "It's available."


def confirm_book_prompt(product: dict[str, Any]) -> str:
    title = _title(product)
    return (
        f"I found {title}. {_price_phrase(product)} "
        f"Would you like to add {title} to your order?"
    )


def another_book_after_add_prompt(title: str) -> str:
    return f"Got it — I've added {title} to your order. Would you like another book?"


def next_book_prompt() -> str:
    return "Sure — what's the ISBN or title of the next book?"


def cart_summary_and_email_prompt(session: "SessionState") -> str:
    from ..cart.session import get_ledger

    summary = get_ledger(session).cart_summary_text()
    return (
        f"{summary} What email address should I send the secure payment link to?"
    )


def stage_product_candidate(session: "SessionState", product: dict[str, Any]) -> None:
    """Store a catalog hit as the pending book awaiting verbal confirmation."""
    if not product or not product.get("variant_id"):
        return
    session.commerce_pending_candidate = {
        "title": product.get("title") or "",
        "isbn": product.get("isbn") or "",
        "variant_id": product.get("variant_id") or "",
        "price": product.get("price") or "",
        "available": product.get("available", True),
        "product_id": product.get("product_id") or product.get("id") or "",
    }
    session.commerce_flow_status = STATUS_AWAITING_BOOK_CONFIRM
    session.commerce_allow_add = False
    session.last_product_candidate = dict(session.commerce_pending_candidate)
    logger.info(
        "commerce_candidate_staged sid=%s title=%r status=%s",
        (getattr(session, "call_sid", "") or "")[:6],
        _title(session.commerce_pending_candidate),
        STATUS_AWAITING_BOOK_CONFIRM,
    )


def maybe_stage_from_search_payload(session: "SessionState | None", payload: dict[str, Any]) -> None:
    if session is None or not isinstance(payload, dict):
        return
    results = payload.get("results") or []
    if not results:
        return
    top = results[0]
    if isinstance(top, dict) and top.get("variant_id"):
        stage_product_candidate(session, top)


def add_staged_book_to_cart(session: "SessionState") -> Optional[str]:
    """Confirm and add the pending candidate; return title added."""
    candidate = _candidate(session)
    if not candidate.get("variant_id"):
        return None
    from ..cart.session import add_product_candidate, confirm_last_candidate, get_ledger

    title = _title(candidate)
    add_product_candidate(
        session,
        title=title,
        isbn=candidate.get("isbn") or "",
        variant_id=candidate.get("variant_id") or "",
        price=candidate.get("price") or None,
        available=bool(candidate.get("available", True)),
    )
    confirm_last_candidate(session)
    session.commerce_pending_candidate = {}
    session.commerce_allow_add = False
    session.commerce_flow_status = STATUS_AWAITING_ANOTHER_BOOK
    session.payment_cart_confirmed = get_ledger(session).confirmed_count() > 0
    if session.payment_cart_confirmed:
        pfs = getattr(session, "payment_flow_status", "idle") or "idle"
        if pfs in ("idle", ""):
            session.payment_flow_status = "awaiting_email"
    session.last_confirmed_product = {"title": title, **candidate}
    logger.info(
        "commerce_book_added sid=%s title=%r cart_count=%d",
        (getattr(session, "call_sid", "") or "")[:6],
        title,
        get_ledger(session).confirmed_count(),
    )
    return title


def on_book_added_to_cart(session: "SessionState", title: str = "") -> None:
    """Called after add_to_cart succeeds — enforce another-book step."""
    session.commerce_pending_candidate = {}
    session.commerce_allow_add = False
    session.commerce_flow_status = STATUS_AWAITING_ANOTHER_BOOK
    session.payment_cart_confirmed = _cart_has_confirmed_items(session)
    if title:
        session.last_confirmed_product = {"title": title}


def commerce_flow_active(session: "SessionState") -> bool:
    return _status(session) != STATUS_IDLE


def commerce_blocks_open_commerce(session: "SessionState") -> bool:
    """True when payment email capture should take priority over commerce."""
    if getattr(session, "awaiting_payment_email_confirmation", False):
        return True
    if getattr(session, "payment_email_confirmed", False):
        return True
    return _status(session) == STATUS_AWAITING_EMAIL_COLLECTION


def commerce_add_to_cart_allowed(session: "SessionState") -> bool:
    if getattr(session, "commerce_allow_add", False):
        return True
    if _status(session) == STATUS_AWAITING_BOOK_CONFIRM and _candidate(session):
        return False
    return True


def gate_add_to_cart(session: "SessionState") -> Optional[PaymentGateResult]:
    if commerce_add_to_cart_allowed(session):
        return None
    candidate = _candidate(session)
    msg = confirm_book_prompt(candidate) if candidate else (
        "I need you to confirm the book before I add it. Would you like to add it?"
    )
    payload = build_payment_tool_result(
        success=False,
        customer_message=msg,
        error_code="book_not_confirmed",
        retryable=True,
    )
    logger.info(
        "commerce_gate_add_to_cart sid=%s reason=book_not_confirmed",
        (getattr(session, "call_sid", "") or "")[:6],
    )
    return PaymentGateResult(allowed=False, tool_json=json.dumps(payload), reason="book_not_confirmed")


def process_commerce_turn(session: "SessionState", caller_text: str) -> CommerceTurnHint:
    """
    Deterministic commerce steps before OpenAI.

    Handles book confirm, another-book, and done-shopping → email collection.
    """
    if commerce_blocks_open_commerce(session):
        return CommerceTurnHint()

    text = (caller_text or "").strip()
    if not text:
        return CommerceTurnHint()

    status = _status(session)

    if status == STATUS_AWAITING_BOOK_CONFIRM:
        if _is_affirmative(text):
            title = add_staged_book_to_cart(session)
            if title:
                return CommerceTurnHint(
                    force_reply=another_book_after_add_prompt(title),
                    book_added=True,
                )
        if _NEGATE_PAT.match(text):
            session.commerce_pending_candidate = {}
            session.commerce_flow_status = STATUS_IDLE
            return CommerceTurnHint(
                force_reply="No problem. Would you like to look up a different book?",
            )
        return CommerceTurnHint()

    if status == STATUS_AWAITING_ANOTHER_BOOK:
        if _NEGATE_PAT.match(text):
            session.commerce_flow_status = STATUS_AWAITING_EMAIL_COLLECTION
            session.payment_flow_status = "awaiting_email"
            return CommerceTurnHint(force_reply=cart_summary_and_email_prompt(session))
        if _is_affirmative(text) or _ANOTHER_PAT.search(text):
            session.commerce_flow_status = STATUS_IDLE
            return CommerceTurnHint(force_reply=next_book_prompt())
        return CommerceTurnHint()

    return CommerceTurnHint()


def enforce_commerce_response(
    session: "SessionState",
    llm_text: str,
    tool_results: list[tuple[str, dict]],
) -> str:
    """
    Override LLM text when commerce tool results require a deterministic follow-up.
    """
    if commerce_blocks_open_commerce(session):
        return llm_text

    # After a blocked add_to_cart, use the gate message.
    for name, result in tool_results:
        if name == "add_to_cart" and not result.get("success") and result.get("error_code") == "book_not_confirmed":
            return result.get("customer_message") or llm_text

    added_titles: list[str] = []
    for name, result in tool_results:
        if name == "add_to_cart" and result.get("success"):
            cart = result.get("cart") or {}
            titles = cart.get("confirmed_titles") or []
            if titles:
                added_titles.append(titles[-1])

    if added_titles and _status(session) == STATUS_AWAITING_ANOTHER_BOOK:
        return another_book_after_add_prompt(added_titles[-1])

    search_hits = [
        (n, r) for n, r in tool_results
        if n in ("search_products", "catalog_search", "get_product_details") and r
    ]
    if search_hits and _status(session) == STATUS_AWAITING_BOOK_CONFIRM:
        candidate = _candidate(session)
        if candidate:
            return confirm_book_prompt(candidate)

    return llm_text


def post_tool_commerce_message(session: "SessionState", tool_results: list[tuple[str, dict]]) -> Optional[str]:
    """Return a spoken follow-up when tool results advance commerce without LLM text."""
    if commerce_blocks_open_commerce(session):
        return None
    for name, result in tool_results:
        if name in ("search_products", "catalog_search") and result.get("results"):
            candidate = _candidate(session)
            if candidate:
                return confirm_book_prompt(candidate)
        if name == "get_product_details" and result.get("variant_id"):
            candidate = _candidate(session)
            if candidate:
                return confirm_book_prompt(candidate)
        if name == "add_to_cart" and result.get("success"):
            cart = result.get("cart") or {}
            titles = cart.get("confirmed_titles") or []
            if titles and _status(session) == STATUS_AWAITING_ANOTHER_BOOK:
                return another_book_after_add_prompt(titles[-1])
    return None
