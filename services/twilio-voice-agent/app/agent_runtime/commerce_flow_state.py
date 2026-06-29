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
from ..voice.title_speech import spoken_book_title

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

COMMERCE_FLOW_VERSION = "v4.54"

STATUS_IDLE = "idle"
STATUS_AWAITING_BOOK_CONFIRM = "awaiting_book_confirm"
STATUS_AWAITING_QUANTITY = "awaiting_quantity"
STATUS_AWAITING_ADD_CONFIRM = "awaiting_add_confirm"
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
    if _AFFIRM_PAT.match(t) or _AFFIRM_LOOSE_PAT.match(t):
        return True
    if re.match(r"^\s*(yeah\s+)?sure\b", t, re.IGNORECASE):
        return True
    return False


_ANOTHER_PAT = re.compile(
    r"\b(another (?:one|book)|i need another|i want another|one more book|"
    r"next book|a different book|look up another|find another)\b",
    re.IGNORECASE,
)
_NO_BUT_ANOTHER_PAT = re.compile(
    r"\bno\b.*\b(another|more)\b.*\b(book|one)\b",
    re.IGNORECASE,
)
_DONE_SHOPPING_PAT = re.compile(
    r"\b(no,? that.?s all|that.?s all|checkout|send (?:the )?payment link|"
    r"payment link|done shopping|ready to pay|i.?m done)\b",
    re.IGNORECASE,
)
_CART_INQUIRY_PAT = re.compile(
    r"\b(how many (?:books?|items?|cop(?:y|ies))(?:\s+(?:are\s+)?in my cart)?|"
    r"what(?:'s| is) in my cart|books? in (?:my )?cart|cart count|"
    r"how (?:book|books) are added|give me the name|tell me (?:the )?name)\b",
    re.IGNORECASE,
)
_NTH_BOOK_PAT = re.compile(
    r"\b(?P<ord>first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s+book\b",
    re.IGNORECASE,
)
_CART_PURCHASE_INTENT_PAT = re.compile(
    r"\b(need|want|buy|order|get|give|isbn|add|look(?:ing)?\s+up)\b",
    re.IGNORECASE,
)
_REPEATED_NO_PAT = re.compile(r"(?:\bno\b[.!,\s]*){2,}", re.IGNORECASE)
_PREVIOUS_BOOK_QTY_PAT = re.compile(
    r"\b(?:and\s+)?(?P<qty>one|a|\d+)\s+(?:copy|copies)\s+of\s+(?:the\s+)?previous\s+book\b",
    re.IGNORECASE,
)
_THIS_THAT_BOOK_QTY_PAT = re.compile(
    r"\b(?P<qty>one|a|\d+|\d+\s+copy|\d+\s+copies)\s+(?:copy|copies)?\s+of\s+"
    r"(?:this|that|the same)(?:\s+book|\s+one)?\b",
    re.IGNORECASE,
)
_ADD_INTENT_PAT = re.compile(
    r"\b(add it|add this|i need this|i want this|take it|one copy|1 copy|"
    r"add\s+\d|add\s+one)\b",
    re.IGNORECASE,
)
_CONFIRM_FRUSTRATION_PAT = re.compile(
    r"\b(why are you not|not asking|not continue|not talking|keep silence|keep quiet|"
    r"hello\.?\s*hello|are you there|talking with me|why are you silent)\b",
    re.IGNORECASE,
)
_YES_IN_UTTERANCE = re.compile(r"\b(yes|yeah|yep|yup|sure)\b", re.IGNORECASE)
_QUANTITY_ADD_INTENT = re.compile(
    r"\b(?:need|want|like|get|order)\b.*\b(?:copies?|copy)\b",
    re.IGNORECASE,
)
_HOLD_OR_WAIT_PAT = re.compile(
    r"\b(hold|wait|one moment|second|hello|quiet|speak|not continue|isbn)\b",
    re.IGNORECASE,
)
_OOS_UTTERANCE = re.compile(
    r"\b(out of stock|not available|unavailable|can't order|cannot order)\b",
    re.IGNORECASE,
)
_ISBN_READY_PAT = re.compile(
    r"\b(isbn|i give you|find for me|read the isbn)\b",
    re.IGNORECASE,
)
_ANOTHER_BOOK_INTENT_PAT = re.compile(
    r"\b(another\s+book|need another|next\s+book|one more book|\banother\b)",
    re.IGNORECASE,
)
_QUANTITY_PAT = re.compile(
    r"\b(\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten|"
    r"eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|"
    r"hundred|a hundred|one hundred)(?:\s+hundred)?\s*(?:cop(?:y|ies)|books?)?\b",
    re.IGNORECASE,
)
_PRICE_SELECT_PAT = re.compile(
    r"(?:\$|\b)(\d{1,4})(?:[.,]\d{2})?\s*(?:dollars?|bucks?|usd)?\b",
    re.IGNORECASE,
)


@dataclass
class CommerceTurnHint:
    force_reply: Optional[str] = None
    book_added: bool = False


def _status(session: "SessionState") -> str:
    return getattr(session, "commerce_flow_status", STATUS_IDLE) or STATUS_IDLE


_CART_BUILDING_STATUSES = frozenset({
    STATUS_AWAITING_BOOK_CONFIRM,
    STATUS_AWAITING_QUANTITY,
    STATUS_AWAITING_ADD_CONFIRM,
    STATUS_AWAITING_ANOTHER_BOOK,
})


def commerce_cart_building_active(session: "SessionState") -> bool:
    """True while the caller is still adding books — payment must not take over."""
    status = _status(session)
    if status in _CART_BUILDING_STATUSES:
        return True
    if status == STATUS_IDLE and _candidate(session).get("variant_id"):
        return True
    return False


def reset_payment_preflight(session: "SessionState") -> None:
    """Caller is still shopping — do not collect payment email yet."""
    if _status(session) == STATUS_AWAITING_EMAIL_COLLECTION:
        return
    session.payment_flow_status = "idle"
    session.awaiting_payment_email = False
    session.awaiting_payment_email_confirmation = False


def _candidate(session: "SessionState") -> dict[str, Any]:
    return dict(getattr(session, "commerce_pending_candidate", None) or {})


def _resolve_pending_candidate(session: "SessionState") -> dict[str, Any]:
    c = _candidate(session)
    if c.get("variant_id"):
        return c
    lpc = dict(getattr(session, "last_product_candidate", None) or {})
    if lpc.get("variant_id"):
        return lpc
    return {}


def _is_add_affirmative(text: str) -> bool:
    return _is_affirmative(text) or bool(_ADD_INTENT_PAT.search(text or ""))


def _confirms_pending_add(text: str) -> bool:
    """True when the caller is confirming a staged add-to-cart step."""
    t = (text or "").strip()
    if not t:
        return False
    if re.match(r"^\s*no\b", t, re.IGNORECASE) or _NEGATE_PAT.match(t):
        return False
    if _is_add_affirmative(t):
        return True
    if _YES_IN_UTTERANCE.search(t):
        return True
    return False


def _title(product: dict[str, Any]) -> str:
    raw = (product.get("title") or product.get("name") or "that book").strip()
    return spoken_book_title(raw)


def _full_title(product: dict[str, Any]) -> str:
    return (product.get("title") or product.get("name") or "that book").strip()


def _price_phrase(product: dict[str, Any]) -> str:
    price = (product.get("price") or "").strip()
    if price and price.upper() != "N/A":
        return f"It's {price}."
    return "It's available."


def confirm_book_prompt(product: dict[str, Any]) -> str:
    """Legacy alias — use quantity_prompt for new staged books."""
    return quantity_prompt(product)


def quantity_prompt(product: dict[str, Any]) -> str:
    title = _title(product)
    return (
        f"Found it — {title}. {_price_phrase(product)} "
        f"How many copies would you like?"
    )


def add_confirm_prompt(product: dict[str, Any], quantity: int = 1) -> str:
    title = _title(product)
    copy_phrase = "one copy" if quantity == 1 else f"{quantity} copies"
    return f"Add {copy_phrase} of {title}?"


def _parse_quantity(text: str) -> int | None:
    from ..cart.quantity import parse_spoken_quantity

    if _is_affirmative((text or "").strip()):
        return 1
    return parse_spoken_quantity(text)


def _parse_price_amount(text: str) -> float | None:
    """Parse a spoken dollar amount (e.g. '11 dollars', '$9.99')."""
    t = (text or "").strip()
    if not t:
        return None
    m = _PRICE_SELECT_PAT.search(t)
    if not m:
        return None
    try:
        return float(m.group(1))
    except ValueError:
        return None


def _ordinal_index(word: str) -> int | None:
    mapping = {
        "first": 1,
        "1st": 1,
        "second": 2,
        "2nd": 2,
        "third": 3,
        "3rd": 3,
        "fourth": 4,
        "4th": 4,
        "fifth": 5,
        "5th": 5,
    }
    return mapping.get((word or "").lower().strip("#"))


def _spoken_cart_line(item, *, index: int | None = None) -> str:
    from ..cart.session import CartItem  # noqa: F401

    qty = max(1, int(getattr(item, "quantity", 1) or 1))
    title = spoken_book_title(getattr(item, "title", "") or "that book")
    copy_phrase = "one copy" if qty == 1 else f"{qty} copies"
    prefix = ""
    if index is not None:
        ordinals = ("first", "second", "third", "fourth", "fifth")
        if 1 <= index <= len(ordinals):
            prefix = f"The {ordinals[index - 1]} book is {title} — {copy_phrase}."
            return prefix
    return f"{copy_phrase} of {title}"


def try_cart_inquiry_reply(
    session: "SessionState",
    caller_text: str,
    *,
    turn_mode: str = "",
) -> Optional[str]:
    """Deterministic cart summary for 'how many books' / 'third book' questions."""
    from ..cart.session import get_ledger
    from ..tools.isbn import extract_isbn_candidate

    text = (caller_text or "").strip()
    if not text:
        return None
    if (turn_mode or "").strip().lower() == "isbn" or extract_isbn_candidate(text):
        return None
    if _NTH_BOOK_PAT.search(text) and _CART_PURCHASE_INTENT_PAT.search(text):
        if not (
            _CART_INQUIRY_PAT.search(text)
            or re.search(r"\bin my cart\b", text, re.I)
        ):
            return None
    if not _cart_has_confirmed_items(session):
        if _CART_INQUIRY_PAT.search(text) or _NTH_BOOK_PAT.search(text):
            return "Your cart is empty right now."
        return None
    if not (_CART_INQUIRY_PAT.search(text) or _NTH_BOOK_PAT.search(text)):
        return None

    ledger = get_ledger(session)
    confirmed = ledger.confirmed_items
    if not confirmed:
        return "Your cart is empty right now."

    nth = _NTH_BOOK_PAT.search(text)
    if nth:
        idx = _ordinal_index(nth.group("ord"))
        if idx and idx <= len(confirmed):
            return _spoken_cart_line(confirmed[idx - 1], index=idx)

    total_titles = len(confirmed)
    total_copies = sum(max(1, int(i.quantity or 1)) for i in confirmed)
    title_word = "title" if total_titles == 1 else "titles"
    copy_word = "copy" if total_copies == 1 else "copies"
    lines = [_spoken_cart_line(item) for item in confirmed]
    if re.search(r"\bhow many\b", text, re.I) and not _NTH_BOOK_PAT.search(text):
        return (
            f"You have {total_titles} {title_word} in your cart, "
            f"{total_copies} {copy_word} total."
        )
    return "In your cart: " + ". ".join(lines) + "."


def _try_add_nth_book(session: "SessionState", text: str) -> Optional[CommerceTurnHint]:
    """Add copies of a cart line by ordinal — e.g. '10 copies of the third book'."""
    m = _NTH_BOOK_PAT.search(text or "")
    if not m:
        return None
    from ..cart.session import get_ledger

    confirmed = get_ledger(session).confirmed_items
    idx = _ordinal_index(m.group("ord"))
    if not idx or idx > len(confirmed):
        return CommerceTurnHint(
            force_reply=(
                "I don't have that many books in your cart yet. "
                "Tell me the ISBN or title you want to add."
            ),
        )
    target = confirmed[idx - 1]
    qty = _parse_quantity(text) or 1
    candidate = {
        "title": target.title,
        "isbn": target.isbn or "",
        "variant_id": target.variant_id or "",
        "price": target.price or "",
        "available": bool(target.available),
        "product_id": target.product_id or "",
    }
    session.commerce_pending_candidate = candidate
    session.commerce_pending_quantity = qty
    if _QUANTITY_ADD_INTENT.search(text) or (
        _YES_IN_UTTERANCE.search(text) and qty > 0
    ):
        title = add_staged_book_to_cart(session, quantity=qty)
        if title:
            copy_phrase = "one copy" if qty == 1 else f"{qty} copies"
            short = spoken_book_title(title)
            return CommerceTurnHint(
                force_reply=(
                    f"Got it — added {copy_phrase} of {short}. "
                    f"{another_book_after_add_prompt()}"
                ),
                book_added=True,
            )
    session.commerce_flow_status = STATUS_AWAITING_ADD_CONFIRM
    return CommerceTurnHint(force_reply=add_confirm_prompt(candidate, qty))


def _try_add_previous_book(session: "SessionState", text: str) -> Optional[CommerceTurnHint]:
    """Add another copy of the book mentioned just before the current one."""
    m = _PREVIOUS_BOOK_QTY_PAT.search(text or "")
    if not m:
        return _try_add_this_that_book(session, text)
    from ..cart.session import get_ledger

    confirmed = get_ledger(session).confirmed_items
    if len(confirmed) < 1:
        return CommerceTurnHint(
            force_reply="Which book did you mean? Give me the ISBN or title again.",
        )
    target = confirmed[0] if len(confirmed) == 1 else confirmed[-2] if len(confirmed) >= 2 else confirmed[0]
    qty = _parse_quantity(m.group("qty")) or 1
    session.commerce_pending_candidate = {
        "title": target.title,
        "isbn": target.isbn or "",
        "variant_id": target.variant_id or "",
        "price": target.price or "",
        "available": bool(target.available),
        "product_id": target.product_id or "",
    }
    session.commerce_pending_quantity = qty
    session.commerce_flow_status = STATUS_AWAITING_ADD_CONFIRM
    return CommerceTurnHint(force_reply=add_confirm_prompt(session.commerce_pending_candidate, qty))


def _try_add_this_that_book(session: "SessionState", text: str) -> Optional[CommerceTurnHint]:
    """Resolve '2 copies of this/that' to staged or last-confirmed book."""
    m = _THIS_THAT_BOOK_QTY_PAT.search(text or "")
    if not m:
        return None
    qty = _parse_quantity(m.group("qty")) or _parse_quantity(text) or 1
    candidate = _resolve_pending_candidate(session)
    if not candidate.get("variant_id"):
        last = dict(getattr(session, "last_confirmed_product", None) or {})
        if last.get("variant_id"):
            candidate = last
    if not candidate.get("variant_id"):
        from ..cart.session import get_ledger

        confirmed = get_ledger(session).confirmed_items
        if confirmed:
            last_item = confirmed[-1]
            candidate = {
                "title": last_item.title,
                "isbn": last_item.isbn or "",
                "variant_id": last_item.variant_id or "",
                "price": last_item.price or "",
                "available": bool(last_item.available),
                "product_id": last_item.product_id or "",
            }
    if not candidate.get("variant_id"):
        return CommerceTurnHint(
            force_reply="Which book did you mean — this one or another? Give me the ISBN or title.",
        )
    session.commerce_pending_candidate = candidate
    session.commerce_pending_quantity = qty
    if _QUANTITY_ADD_INTENT.search(text) or (
        _YES_IN_UTTERANCE.search(text) and qty > 0
    ) or qty > 1:
        title = add_staged_book_to_cart(session, quantity=qty)
        if title:
            copy_phrase = "one copy" if qty == 1 else f"{qty} copies"
            short = spoken_book_title(title)
            return CommerceTurnHint(
                force_reply=(
                    f"Got it — added {copy_phrase} of {short}. "
                    f"{another_book_after_add_prompt()}"
                ),
                book_added=True,
            )
    session.commerce_flow_status = STATUS_AWAITING_ADD_CONFIRM
    return CommerceTurnHint(force_reply=add_confirm_prompt(candidate, qty))


def _price_matches(product_price: str, amount: float) -> bool:
    raw = (product_price or "").replace("$", "").replace(",", "").strip()
    if not raw:
        return False
    try:
        return abs(float(raw) - amount) < 0.02
    except ValueError:
        return False


def _try_apply_variant_price_selection(session: "SessionState", text: str) -> bool:
    """When catalog returned multiple prices, restage the variant the caller picked."""
    results = list(getattr(session, "commerce_last_catalog_results", None) or [])
    if len(results) < 2:
        return False
    amount = _parse_price_amount(text)
    if amount is None:
        return False
    for hit in results:
        if _price_matches(str(hit.get("price") or ""), amount):
            stage_product_candidate(session, hit)
            logger.info(
                "commerce_variant_selected sid=%s price=%.2f title=%r",
                (getattr(session, "call_sid", "") or "")[:6],
                amount,
                _title(hit),
            )
            return True
    return False


def _unlock_add_after_quantity(session: "SessionState", qty: int) -> None:
    """LLM-only: spoken quantity is enough confirmation to call add_to_cart."""
    session.commerce_pending_quantity = qty
    session.commerce_flow_status = STATUS_AWAITING_ADD_CONFIRM
    session.commerce_allow_add = True


def another_book_after_add_prompt(title: str = "") -> str:
    return "Would you like to add another book?"


def next_book_prompt() -> str:
    return "What's the next ISBN or title?"


def cart_summary_and_email_prompt(session: "SessionState") -> str:
    from ..cart.session import get_ledger
    from ..payment.payment_destination_groups import ensure_payment_groups
    from ..payment.payment_prompts import payment_email_collection_prompt
    from ..payment.payment_state_machine import begin_awaiting_payment_email

    summary = get_ledger(session).cart_summary_text()
    ensure_payment_groups(session)
    begin_awaiting_payment_email(session)
    return payment_email_collection_prompt(cart_summary=summary)


def advance_commerce_state_silent(session: "SessionState", caller_text: str) -> None:
    """
    LLM-only: advance commerce gates from caller speech without canned replies.

    Unlocks ``add_to_cart`` after quantity + confirmation so the LLM can call
    the tool without ``book_not_confirmed`` gates.
    """
    if commerce_blocks_open_commerce(session):
        return
    text = (caller_text or "").strip()
    if not text:
        return

    if _DONE_SHOPPING_PAT.search(text) and _cart_has_confirmed_items(session):
        session.commerce_flow_status = STATUS_AWAITING_EMAIL_COLLECTION
        session.payment_flow_status = "awaiting_email"
        session.awaiting_product_confirmation = False
        from ..payment.payment_destination_groups import ensure_payment_groups

        ensure_payment_groups(session)
        return

    status = _status(session)

    if status == STATUS_AWAITING_ANOTHER_BOOK:
        if _HOLD_OR_WAIT_PAT.search(text) or _ISBN_READY_PAT.search(text):
            return
        if _ANOTHER_PAT.search(text) or _NO_BUT_ANOTHER_PAT.search(text):
            return

    candidate = _resolve_pending_candidate(session)
    if not candidate:
        return

    if status == STATUS_AWAITING_QUANTITY:
        applied_price = _try_apply_variant_price_selection(session, text)
        if not applied_price:
            qty = _parse_quantity(text)
            if qty:
                _unlock_add_after_quantity(session, qty)
            elif _confirms_pending_add(text):
                session.commerce_pending_quantity = _parse_quantity(text) or 1
                session.commerce_allow_add = True

    elif status == STATUS_AWAITING_ADD_CONFIRM:
        applied_price = _try_apply_variant_price_selection(session, text)
        if not applied_price:
            qty = _parse_quantity(text)
            if qty:
                _unlock_add_after_quantity(session, qty)
            elif _confirms_pending_add(text):
                if not session.commerce_pending_quantity:
                    session.commerce_pending_quantity = 1
                session.commerce_allow_add = True

    elif status == STATUS_AWAITING_BOOK_CONFIRM and _confirms_pending_add(text):
        session.commerce_flow_status = STATUS_AWAITING_QUANTITY


def stage_product_candidate(session: "SessionState", product: dict[str, Any]) -> None:
    """Store a catalog hit as the pending book awaiting verbal confirmation."""
    product = normalize_catalog_hit(product)
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
    session.commerce_flow_status = STATUS_AWAITING_QUANTITY
    session.commerce_allow_add = False
    session.commerce_pending_quantity = 0
    session.last_product_candidate = dict(session.commerce_pending_candidate)
    session.awaiting_product_confirmation = True
    logger.info(
        "commerce_candidate_staged sid=%s title=%r status=%s",
        (getattr(session, "call_sid", "") or "")[:6],
        _title(session.commerce_pending_candidate),
        STATUS_AWAITING_QUANTITY,
    )


def normalize_catalog_hit(item: dict[str, Any]) -> dict[str, Any]:
    """Ensure variant_id/price exist when Shopify returns variants[] only."""
    if not item:
        return {}
    out = dict(item)
    variants = out.get("variants") or []
    if not out.get("variant_id") and variants and isinstance(variants[0], dict):
        v0 = variants[0]
        out["variant_id"] = v0.get("id") or v0.get("variant_id") or ""
        if not out.get("price"):
            out["price"] = v0.get("price") or ""
    return out


def maybe_stage_from_search_payload(session: "SessionState | None", payload: dict[str, Any]) -> None:
    if session is None or not isinstance(payload, dict):
        return
    results = payload.get("results") or []
    if not results:
        return
    normalized = [
        normalize_catalog_hit(r)
        for r in results
        if isinstance(r, dict)
    ]
    hits = [h for h in normalized if h.get("variant_id")]
    if hits:
        session.commerce_last_catalog_results = hits
    top = hits[0] if hits else {}
    if top.get("variant_id"):
        stage_product_candidate(session, top)


def add_staged_book_to_cart(session: "SessionState", quantity: int = 1) -> Optional[str]:
    """Confirm and add the pending candidate; return title added."""
    candidate = _candidate(session)
    if not candidate.get("variant_id"):
        return None
    from ..cart.session import add_product_candidate, confirm_last_candidate, get_ledger

    title = _full_title(candidate)
    qty = max(1, int(quantity or getattr(session, "commerce_pending_quantity", 0) or 1))
    add_product_candidate(
        session,
        title=title,
        isbn=candidate.get("isbn") or "",
        variant_id=candidate.get("variant_id") or "",
        price=candidate.get("price") or None,
        available=bool(candidate.get("available", True)),
        quantity=qty,
    )
    confirm_last_candidate(session)
    from ..payment.payment_destination_groups import refresh_payment_groups_from_cart
    from ..conversation.call_memory import record_cart_confirmed

    record_cart_confirmed(session, title=title, count=qty)
    refresh_payment_groups_from_cart(session)
    session.commerce_pending_candidate = {}
    session.commerce_pending_quantity = 0
    session.commerce_allow_add = False
    session.commerce_flow_status = STATUS_AWAITING_ANOTHER_BOOK
    session.pending_isbn_buffer = ""
    session.payment_cart_confirmed = get_ledger(session).confirmed_count() > 0
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
    """True when another workflow should take priority over commerce."""
    if getattr(session, "awaiting_not_found_escalation_email", False):
        return True
    from .order_flow_state import (
        STATUS_AWAITING_ORDER_NUMBER,
        STATUS_AWAITING_ORDER_VERIFICATION,
    )

    ofs = getattr(session, "order_flow_status", "idle") or "idle"
    if ofs in (STATUS_AWAITING_ORDER_NUMBER, STATUS_AWAITING_ORDER_VERIFICATION):
        return True
    if getattr(session, "awaiting_payment_email_confirmation", False):
        return True
    if getattr(session, "payment_email_confirmed", False):
        return True
    return _status(session) == STATUS_AWAITING_EMAIL_COLLECTION


def commerce_add_to_cart_allowed(session: "SessionState") -> bool:
    if getattr(session, "commerce_allow_add", False):
        return True
    if _status(session) in (
        STATUS_AWAITING_BOOK_CONFIRM,
        STATUS_AWAITING_QUANTITY,
        STATUS_AWAITING_ADD_CONFIRM,
    ) and _candidate(session):
        return False
    return True


def gate_add_to_cart(session: "SessionState") -> Optional[PaymentGateResult]:
    if commerce_add_to_cart_allowed(session):
        return None
    candidate = _candidate(session)
    msg = quantity_prompt(candidate) if candidate else (
        "I need you to confirm the book before I add it. How many copies would you like?"
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


def process_commerce_turn(
    session: "SessionState",
    caller_text: str,
    *,
    turn_mode: str = "",
) -> CommerceTurnHint:
    """
    Deterministic commerce steps before OpenAI.

    Handles book confirm, another-book, and done-shopping → email collection.
    """
    mode = (turn_mode or "").strip().lower()
    if mode in ("isbn", "order", "email"):
        return CommerceTurnHint()

    text = (caller_text or "").strip()
    if not text:
        return CommerceTurnHint()

    from ..tools.isbn import extract_isbn_candidate

    status = _status(session)
    mentions_isbn = bool(
        extract_isbn_candidate(text)
        or re.search(r"\b(isbn|iouspl|ouspl|iuspl)\b", text, re.I)
    )
    if mentions_isbn:
        if status == STATUS_AWAITING_ANOTHER_BOOK and not extract_isbn_candidate(text):
            if _ISBN_READY_PAT.search(text) or _HOLD_OR_WAIT_PAT.search(text):
                return CommerceTurnHint(
                    force_reply="Sure — take your time. Give me the ISBN when you're ready.",
                )
            if _ANOTHER_BOOK_INTENT_PAT.search(text):
                return CommerceTurnHint(force_reply=next_book_prompt())
        else:
            return CommerceTurnHint()

    if commerce_blocks_open_commerce(session):
        return CommerceTurnHint()

    candidate = _resolve_pending_candidate(session)
    this_that = _try_add_this_that_book(session, text)
    if this_that is not None:
        return this_that

    active_quantity_step = status in (
        STATUS_AWAITING_QUANTITY,
        STATUS_AWAITING_ADD_CONFIRM,
    ) and bool(candidate.get("variant_id"))
    if not active_quantity_step:
        nth_book = _try_add_nth_book(session, text)
        if nth_book is not None:
            return nth_book
        prev_book = _try_add_previous_book(session, text)
        if prev_book is not None:
            return prev_book
        status = _status(session)
        candidate = _resolve_pending_candidate(session)

    if _REPEATED_NO_PAT.search(text) and _cart_has_confirmed_items(session):
        if status in (STATUS_AWAITING_ANOTHER_BOOK, STATUS_AWAITING_QUANTITY, STATUS_AWAITING_ADD_CONFIRM):
            session.commerce_flow_status = STATUS_AWAITING_EMAIL_COLLECTION
            session.payment_flow_status = "awaiting_email"
            session.awaiting_product_confirmation = False
            return CommerceTurnHint(force_reply=cart_summary_and_email_prompt(session))

    if _NO_BUT_ANOTHER_PAT.search(text):
        session.commerce_flow_status = STATUS_IDLE
        session.awaiting_product_confirmation = False
        return CommerceTurnHint(force_reply=next_book_prompt())

    if _DONE_SHOPPING_PAT.search(text) and _cart_has_confirmed_items(session):
        session.commerce_flow_status = STATUS_AWAITING_EMAIL_COLLECTION
        session.payment_flow_status = "awaiting_email"
        session.awaiting_product_confirmation = False
        return CommerceTurnHint(force_reply=cart_summary_and_email_prompt(session))

    if status == STATUS_AWAITING_QUANTITY and candidate:
        if _OOS_UTTERANCE.search(text):
            from .not_found_escalation_flow import begin_unavailable_product_handoff

            query = (candidate.get("isbn") or candidate.get("title") or text).strip()
            msg = begin_unavailable_product_handoff(
                session,
                user_text=caller_text,
                query=query,
                reason="product_out_of_stock",
                product_title=(candidate.get("title") or "").strip(),
            )
            return CommerceTurnHint(force_reply=msg)
        if _ISBN_READY_PAT.search(text) and not _parse_quantity(text):
            session.commerce_pending_candidate = {}
            session.commerce_flow_status = STATUS_IDLE
            session.pending_isbn_buffer = ""
            session.awaiting_product_confirmation = False
            return CommerceTurnHint(force_reply="Sure — go ahead with the ISBN when you're ready.")
        if _HOLD_OR_WAIT_PAT.search(text) and not _parse_quantity(text):
            short = spoken_book_title(_title(candidate))
            return CommerceTurnHint(
                force_reply=f"No rush — how many copies of {short} would you like?",
            )
        qty = _parse_quantity(text)
        if qty:
            if _QUANTITY_ADD_INTENT.search(text) or (
                _YES_IN_UTTERANCE.search(text) and qty > 1
            ) or qty > 1:
                session.commerce_pending_quantity = qty
                session.commerce_pending_candidate = candidate
                title = add_staged_book_to_cart(session, quantity=qty)
                session.awaiting_product_confirmation = False
                if title:
                    copy_phrase = "one copy" if qty == 1 else f"{qty} copies"
                    short = spoken_book_title(title)
                    return CommerceTurnHint(
                        force_reply=(
                            f"Got it — added {copy_phrase} of {short}. "
                            f"{another_book_after_add_prompt()}"
                        ),
                        book_added=True,
                    )
            session.commerce_pending_quantity = qty
            session.commerce_flow_status = STATUS_AWAITING_ADD_CONFIRM
            return CommerceTurnHint(force_reply=add_confirm_prompt(candidate, qty))
        if _NEGATE_PAT.match(text):
            session.commerce_pending_candidate = {}
            session.commerce_flow_status = STATUS_IDLE
            session.awaiting_product_confirmation = False
            return CommerceTurnHint(
                force_reply="No problem. Would you like to look up a different book?",
            )
        return CommerceTurnHint(force_reply=quantity_prompt(candidate))

    if status == STATUS_AWAITING_ADD_CONFIRM and candidate:
        qty_override = _parse_quantity(text)
        if qty_override and not _confirms_pending_add(text):
            session.commerce_pending_quantity = qty_override
            if _QUANTITY_ADD_INTENT.search(text) or qty_override > 1:
                session.commerce_pending_candidate = candidate
                title = add_staged_book_to_cart(session, quantity=qty_override)
                session.awaiting_product_confirmation = False
                if title:
                    copy_phrase = "one copy" if qty_override == 1 else f"{qty_override} copies"
                    short = spoken_book_title(title)
                    return CommerceTurnHint(
                        force_reply=(
                            f"Got it — added {copy_phrase} of {short}. "
                            f"{another_book_after_add_prompt()}"
                        ),
                        book_added=True,
                    )
            return CommerceTurnHint(force_reply=add_confirm_prompt(candidate, qty_override))
        if _confirms_pending_add(text):
            qty = _parse_quantity(text) or int(
                getattr(session, "commerce_pending_quantity", 0) or 1
            )
            session.commerce_pending_quantity = qty
            session.commerce_pending_candidate = candidate
            title = add_staged_book_to_cart(session, quantity=qty)
            session.awaiting_product_confirmation = False
            if title:
                copy_phrase = "one copy" if qty == 1 else f"{qty} copies"
                short = spoken_book_title(title)
                return CommerceTurnHint(
                    force_reply=(
                        f"Got it — added {copy_phrase} of {short}. "
                        f"{another_book_after_add_prompt()}"
                    ),
                    book_added=True,
                )
        if _CONFIRM_FRUSTRATION_PAT.search(text):
            short = spoken_book_title(_title(candidate))
            qty = int(getattr(session, "commerce_pending_quantity", 0) or 1)
            copy_phrase = "one copy" if qty == 1 else f"{qty} copies"
            return CommerceTurnHint(
                force_reply=(
                    f"Sorry about that — shall I add {copy_phrase} of {short}? "
                    "Just say yes."
                ),
            )
        if _NEGATE_PAT.match(text):
            session.commerce_pending_candidate = {}
            session.commerce_flow_status = (
                STATUS_AWAITING_ANOTHER_BOOK if _cart_has_confirmed_items(session) else STATUS_IDLE
            )
            session.awaiting_product_confirmation = False
            session.commerce_pending_quantity = 0
            return CommerceTurnHint(
                force_reply=(
                    "No problem — what's the ISBN or title of the book you want?"
                ),
            )
        return CommerceTurnHint(force_reply=add_confirm_prompt(
            candidate, int(getattr(session, "commerce_pending_quantity", 0) or 1),
        ))

    awaiting_confirm = (
        status == STATUS_AWAITING_BOOK_CONFIRM
        or bool(getattr(session, "awaiting_product_confirmation", False))
    )

    if awaiting_confirm and candidate and _is_add_affirmative(text):
        session.commerce_flow_status = STATUS_AWAITING_QUANTITY
        qty = _parse_quantity(text) or 1
        session.commerce_pending_quantity = qty
        session.commerce_flow_status = STATUS_AWAITING_ADD_CONFIRM
        return CommerceTurnHint(force_reply=add_confirm_prompt(candidate, qty))

    if status == STATUS_AWAITING_BOOK_CONFIRM:
        if _NEGATE_PAT.match(text):
            session.commerce_pending_candidate = {}
            session.commerce_flow_status = STATUS_IDLE
            session.awaiting_product_confirmation = False
            return CommerceTurnHint(
                force_reply="No problem. Would you like to look up a different book?",
            )
        return CommerceTurnHint()

    if status == STATUS_AWAITING_ANOTHER_BOOK:
        if _NEGATE_PAT.match(text) and not _NO_BUT_ANOTHER_PAT.search(text):
            session.commerce_flow_status = STATUS_AWAITING_EMAIL_COLLECTION
            session.payment_flow_status = "awaiting_email"
            return CommerceTurnHint(force_reply=cart_summary_and_email_prompt(session))
        if _is_affirmative(text) or _ANOTHER_PAT.search(text) or _ANOTHER_BOOK_INTENT_PAT.search(text):
            reset_payment_preflight(session)
            session.commerce_flow_status = STATUS_IDLE
            session.pending_isbn_buffer = ""
            return CommerceTurnHint(force_reply=next_book_prompt())
        if _HOLD_OR_WAIT_PAT.search(text) or _ISBN_READY_PAT.search(text):
            from ..tools.isbn import extract_isbn_candidate

            if (turn_mode or "").lower() == "isbn" or extract_isbn_candidate(text):
                return CommerceTurnHint()
            return CommerceTurnHint(
                force_reply="Sure — take your time. Give me the ISBN or title when you're ready.",
            )
        return CommerceTurnHint()

    from .yes_engagement import is_bare_yes, yes_engagement_reply

    if is_bare_yes(text):
        reply = yes_engagement_reply(session)
        if reply:
            return CommerceTurnHint(force_reply=reply)

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
        return another_book_after_add_prompt()

    search_hits = [
        (n, r) for n, r in tool_results
        if n in ("search_products", "catalog_search", "get_product_details") and r
    ]
    if search_hits and _status(session) in (
        STATUS_AWAITING_BOOK_CONFIRM,
        STATUS_AWAITING_QUANTITY,
    ):
        candidate = _candidate(session)
        if candidate:
            return quantity_prompt(candidate)

    return llm_text


def post_tool_commerce_message(session: "SessionState", tool_results: list[tuple[str, dict]]) -> Optional[str]:
    """Return a spoken follow-up when tool results advance commerce without LLM text."""
    if commerce_blocks_open_commerce(session):
        return None
    for name, result in tool_results:
        if name in ("search_products", "catalog_search") and result.get("results"):
            candidate = _candidate(session)
            if candidate:
                return quantity_prompt(candidate)
        if name == "get_product_details" and result.get("variant_id"):
            candidate = _candidate(session)
            if candidate:
                return quantity_prompt(candidate)
        if name == "add_to_cart" and result.get("success"):
            cart = result.get("cart") or {}
            titles = cart.get("confirmed_titles") or []
            if titles and _status(session) == STATUS_AWAITING_ANOTHER_BOOK:
                return another_book_after_add_prompt()
    return None
