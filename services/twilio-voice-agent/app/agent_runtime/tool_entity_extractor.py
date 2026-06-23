"""Extract tool entities from caller text and agent decisions (v4.14.5)."""
from __future__ import annotations

import logging
import re
from difflib import SequenceMatcher
from typing import TYPE_CHECKING, Optional

from .business_intent_resolver import extract_isbn_from_text

if TYPE_CHECKING:
    from ..state.models import SessionState
    from .memory_packet import MemoryPacket

logger = logging.getLogger(__name__)

_GENERIC_FOLLOWUP_WORDS = frozenset({
    "price", "amount", "cost", "available", "availability", "stock",
    "these books", "this book", "that book",
})
_PRICE_PAT = re.compile(
    r"^\s*(?:price|amount|cost|what(?:'s| is) the (?:price|amount)|"
    r"how much(?: is it)?|what(?:'s| is) the cost)\s*[.!?]?\s*$",
    re.I,
)
_PRICE_INLINE_PAT = re.compile(
    r"\b(price|amount|cost|how much|what(?:'s| is) the price)\b",
    re.I,
)
_AVAIL_PAT = re.compile(
    r"\b(in stock|available|availability|do you have it|is it available|is this in stock)\b",
    re.I,
)
_ADD_PAT = re.compile(
    r"\b(add it|add this|add this book|yes add it|put it in my cart|add to cart)\b",
    re.I,
)
_REMOVE_PAT = re.compile(
    r"\b(remove it|delete that book|don'?t add that one|exclude that one|take it off)\b",
    re.I,
)
_ISBN_PHRASE_PAT = re.compile(
    r"\b(?:isbn(?:\s+number)?\s+is|isbn(?:\s+number)?(?:\s+of(?:\s+the)?\s+book)?)\b",
    re.I,
)
_TITLE_PATS = (
    re.compile(r"\b(?:the title(?: name)? is|book title is|title name is)\s+(.{2,})", re.I),
    re.compile(r"\bsearch for\s+(.{2,})", re.I),
    re.compile(r"\bi need\s+(?!a(?:\s+a)?\s*book\b|to\b|the book\b|price\b)(.{2,})", re.I),
)
_AUTHOR_PAT = re.compile(
    r"\b(?:books?\s+by|author is|by author)\s+(.{2,})",
    re.I,
)
_SUBJECT_PATS = (
    re.compile(r"\bbooks?\s+about\s+(.+)", re.I),
    re.compile(r"\bbooks?\s+on\s+(.+)", re.I),
    re.compile(r"\b(?:islamic|romance|cricket|football)\s+books?\b", re.I),
    re.compile(r"\b(.+?)\s+(?:book|novel|books)\b", re.I),
)
_ORDER_PATS = (
    re.compile(r"\border(?:\s+number)?\s+is\s+([A-Za-z0-9#-]{3,})", re.I),
    re.compile(r"#(\d{3,})", re.I),
    re.compile(r"\bmy order is\s+([A-Za-z0-9#-]{3,})", re.I),
    re.compile(r"\b(?:order|tracking)\s+#?([A-Za-z0-9-]{3,})", re.I),
)
_EMAIL_PAT = re.compile(
    r"\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b",
)
_PHONE_PAT = re.compile(r"\b(\+?1?\d{10,11})\b")
_REFUND_PAT = re.compile(r"\b(refund|money back|charge\s?back)\b", re.I)
_CART_ADD_PAT = re.compile(
    r"\b(add (?:this|it|that|another|one more|the book)|add another(?: one| book)?)\b",
    re.I,
)
_CART_REMOVE_PAT = re.compile(r"\b(remove (?:it|this|that|from cart)|take it off)\b", re.I)
_CART_COUNT_PAT = re.compile(
    r"\b(how many books?(?:\s+(?:are\s+)?in my cart)?|cart count|books in cart)\b",
    re.I,
)
_PAYMENT_PAT = re.compile(
    r"\b(send (?:me )?(?:the )?payment link|email me (?:the )?payment link|pay now|checkout)\b",
    re.I,
)
_FACILITY_PAT = re.compile(
    r"\b(?:facility|prison|jail|inmate)\b.*?([A-Z][a-zA-Z\s]{2,40}((?:facility|jail|prison|correctional)?))",
    re.I,
)
_FACILITY_APPROVAL_PAT = re.compile(
    r"\b(is|are)\s+([A-Z][a-zA-Z\s]{2,40})\s+(?:facility\s+)?(?:approved|allowed)\b",
    re.I,
)
_ADDRESS_PAT = re.compile(
    r"\b(change|update)\s+(?:my\s+)?(?:shipping\s+)?address\b",
    re.I,
)
_QTY_PATS = (
    re.compile(r"\b(two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:copies|books?|more)\b", re.I),
    re.compile(r"\b(?:add|get)\s+(two|three|four|five|\d+)\b", re.I),
    re.compile(r"\bone more\b", re.I),
)
_SPOKEN_NUMS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
}


def is_generic_followup_phrase(text: str) -> bool:
    lowered = re.sub(r"\s+", " ", (text or "").strip().lower())
    if lowered in _GENERIC_FOLLOWUP_WORDS:
        return True
    if is_price_followup(text) or is_availability_followup(text):
        return True
    if is_add_to_cart_followup(text) or is_remove_from_cart_followup(text):
        return True
    if re.fullmatch(r"(?:i need )?(?:price|amount|cost)[.!?]?", lowered):
        return True
    return False


def is_price_followup(text: str) -> bool:
    normalized = (text or "").strip()
    if re.search(r"\b(shipping|subtotal|delivery|ship)\b", normalized, re.I):
        return False
    if _PRICE_PAT.match(normalized):
        return True
    if _PRICE_INLINE_PAT.search(normalized):
        cleaned = _PRICE_INLINE_PAT.sub("", normalized).strip(" .!?")
        if not cleaned or len(cleaned.split()) <= 4:
            return True
    return False


def is_availability_followup(text: str) -> bool:
    return bool(_AVAIL_PAT.search(text or ""))


def is_add_to_cart_followup(text: str) -> bool:
    return bool(_ADD_PAT.search(text or "") or _CART_ADD_PAT.search(text or ""))


def is_remove_from_cart_followup(text: str) -> bool:
    return bool(_REMOVE_PAT.search(text or "") or _CART_REMOVE_PAT.search(text or ""))


def _normalize_query(text: str) -> str:
    return text.strip().strip('"\'').rstrip(".!?")


def _is_noise_product_phrase(query: str) -> bool:
    lowered = query.lower().strip()
    if is_generic_followup_phrase(lowered):
        return True
    if is_price_followup(lowered):
        return True
    if lowered.startswith("price.") or lowered.startswith("price "):
        return True
    noise_tokens = ("price", "amount", "what is the price", "what's the price")
    if any(tok in lowered for tok in noise_tokens) and len(lowered.split()) <= 6:
        return True
    return False


def _extract_title(text: str) -> str:
    if is_generic_followup_phrase(text):
        return ""
    for pat in _TITLE_PATS:
        match = pat.search(text)
        if match:
            query = _normalize_query(match.group(1))
            if _is_noise_product_phrase(query):
                return ""
            if query.lower() not in {"a book", "the book", "book", "books"} and len(query) >= 2:
                return query
    return ""


def _extract_author(text: str) -> str:
    match = _AUTHOR_PAT.search(text)
    if match:
        return _normalize_query(match.group(1))
    match = re.search(r"\bbooks?\s+by\s+(.+)", text, re.I)
    if match:
        return _normalize_query(match.group(1))
    return ""


def _extract_subject(text: str) -> str:
    if is_generic_followup_phrase(text):
        return ""
    for pat in _SUBJECT_PATS[:2]:
        match = pat.search(text)
        if match:
            return _normalize_query(match.group(1))
    if re.search(r"\bislamic books?\b", text, re.I):
        return "Islamic"
    if re.search(r"\bromance(?:\s+novel|\s+book)?\b", text, re.I):
        return "romance"
    match = _SUBJECT_PATS[3].search(text)
    if match:
        subj = _normalize_query(match.group(1))
        if subj.lower() not in {"a", "the", "this", "that", "another"} and not _is_noise_product_phrase(subj):
            return subj
    return ""


def _extract_order_number(text: str) -> str:
    for pat in _ORDER_PATS:
        match = pat.search(text)
        if match:
            return match.group(1).strip().lstrip("#")
    return ""


def _extract_quantity(text: str) -> Optional[int]:
    if re.search(r"\bone more\b", text, re.I):
        return 1
    for pat in _QTY_PATS:
        match = pat.search(text)
        if match:
            val = match.group(1).lower() if match.lastindex else "1"
            if val.isdigit():
                n = int(val)
                return n if 1 <= n <= 99 else None
            return _SPOKEN_NUMS.get(val)
    return None


def _extract_cart_action(text: str) -> str:
    if is_remove_from_cart_followup(text):
        return "remove"
    if _CART_COUNT_PAT.search(text):
        return "count"
    if is_add_to_cart_followup(text):
        return "add"
    return ""


def _get_expected_next(
    session: Optional["SessionState"] = None,
    memory_packet: Optional["MemoryPacket"] = None,
) -> str:
    if session is not None and hasattr(session, "dialogue"):
        expected = getattr(session.dialogue, "expected_next", "") or ""
        if expected:
            return expected
    return ""


def _match_last_candidate_title(text: str, session: Optional["SessionState"]) -> dict[str, str]:
    if session is None:
        return {}
    candidate = getattr(session, "last_product_candidate", {}) or {}
    title = candidate.get("title") or ""
    if not title:
        return {}
    phrase = _normalize_query(text)
    if _is_noise_product_phrase(phrase):
        return {}
    ratio = SequenceMatcher(None, phrase.lower(), title.lower()).ratio()
    if ratio >= 0.52 or phrase.lower() in title.lower() or title.lower() in phrase.lower():
        out: dict[str, str] = {"selected_candidate_id": str(candidate.get("candidate_id", ""))}
        if candidate.get("variant_id"):
            out["variant_id"] = str(candidate["variant_id"])
        if candidate.get("product_id"):
            out["selected_product_id"] = str(candidate["product_id"])
        return out
    return {}


def extract_tool_entities(
    text: str,
    decision: Optional[dict] = None,
    memory_packet: Optional["MemoryPacket"] = None,
    session: Optional["SessionState"] = None,
) -> dict[str, str]:
    """Merge decision fields, caller text, and memory into worker entities."""
    entities: dict[str, str] = {}
    decision = decision or {}
    normalized = (text or "").strip()

    isbn = extract_isbn_from_text(normalized)
    if isbn:
        entities["isbn"] = isbn

    order_number = _extract_order_number(normalized)
    refund = _REFUND_PAT.search(normalized)
    if refund and order_number:
        entities["refund_request"] = "true"
        entities["order_number"] = order_number
    elif order_number:
        entities["order_number"] = order_number
    elif refund:
        entities["refund_request"] = "true"

    cart_action = _extract_cart_action(normalized)
    if cart_action:
        entities["cart_action"] = cart_action

    qty = _extract_quantity(normalized)
    if qty is not None:
        entities["quantity"] = str(qty)

    if _PAYMENT_PAT.search(normalized):
        entities["payment_request"] = "true"

    if is_generic_followup_phrase(normalized) or decision.get("search_blocked"):
        entities.setdefault("raw_text", normalized)
        sid = session.call_sid[:6] if session else "?"
        logger.info("tool_entities_extracted sid=%s keys=%s", sid, sorted(entities.keys()))
        return entities

    search_query = (decision.get("search_query") or "").strip()
    if search_query and not _is_noise_product_phrase(search_query):
        entities["product_phrase"] = search_query
        if not entities.get("title"):
            entities["title"] = search_query

    tool_entities = decision.get("tool_entities") or {}
    if isinstance(tool_entities, dict):
        for key, value in tool_entities.items():
            if value:
                entities[key] = str(value)

    title = _extract_title(normalized)
    if title and not entities.get("title"):
        entities["title"] = title
        entities.setdefault("product_phrase", title)

    author = _extract_author(normalized)
    if author:
        entities["author"] = author
        entities.setdefault("product_phrase", author)

    subject = _extract_subject(normalized)
    if subject and not entities.get("product_phrase"):
        entities["subject"] = subject
        entities["product_phrase"] = subject

    email_match = _EMAIL_PAT.search(normalized)
    if email_match:
        entities["email"] = email_match.group(1)
        expected = _get_expected_next(session, memory_packet)
        if expected in {"email_capture", "email_confirm", "checkout_create"}:
            entities["needs_email_confirmation"] = "true"

    phone_match = _PHONE_PAT.search(re.sub(r"[^\d+]", "", normalized) or normalized)
    if phone_match:
        digits = re.sub(r"\D", "", phone_match.group(1))
        if len(digits) >= 10:
            entities["phone"] = digits[-10:]

    facility_match = _FACILITY_APPROVAL_PAT.search(normalized) or _FACILITY_PAT.search(normalized)
    if facility_match:
        name = facility_match.group(facility_match.lastindex or 1).strip()
        if name:
            entities["facility_name"] = name[:60]

    if _ADDRESS_PAT.search(normalized):
        entities["address_update"] = "true"

    expected_next = _get_expected_next(session, memory_packet)
    if expected_next and not isbn:
        if expected_next in {"isbn_number", "isbn_digits", "isbn_13_digits"}:
            isbn = extract_isbn_from_text(normalized)
            if isbn:
                entities["isbn"] = isbn

    if session is not None:
        candidate = getattr(session, "last_product_candidate", {}) or {}
        if candidate.get("variant_id") and not entities.get("variant_id"):
            entities["variant_id"] = str(candidate["variant_id"])
        if candidate.get("product_id") and not entities.get("selected_product_id"):
            entities["selected_product_id"] = str(candidate["product_id"])
        if candidate.get("candidate_id") and not entities.get("selected_candidate_id"):
            entities["selected_candidate_id"] = str(candidate["candidate_id"])
        matched = _match_last_candidate_title(normalized, session)
        entities.update({k: v for k, v in matched.items() if v})
        if getattr(session, "confirmed_email", "") and not entities.get("email"):
            entities["customer_id"] = entities.get("email") or session.confirmed_email

    entities.setdefault("raw_text", normalized)
    sid = session.call_sid[:6] if session else "?"
    logger.info("tool_entities_extracted sid=%s keys=%s", sid, sorted(entities.keys()))
    return entities
