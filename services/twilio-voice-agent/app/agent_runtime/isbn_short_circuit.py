"""
Deterministic ISBN lookup for voice turns (v4.31).

When the turn assembler marks ``turn_mode=isbn`` or the caller speaks a
complete ISBN, run ``catalog_search`` directly — do not let the LLM guess
digit counts or mis-parse spaced digits.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Any, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

ISBN_SHORT_CIRCUIT_VERSION = "v4.44"

_META_BOOK_PHRASE_PAT = re.compile(
    r"\b(another\s+(?:book|one|\d)|need another|i need another|yeah|yep|sure|"
    r"hold|wait|just\s+\d|only\s+\d|speak|quiet|hello)\b",
    re.I,
)
_ANOTHER_BOOK_INTENT_PAT = re.compile(
    r"\b(another\s+book|need another|next\s+book|one more book|"
    r"another\s+(?:one|\d+)|need another\s+\d+)\b",
    re.I,
)
_TITLE_NOT_ISBN_PAT = re.compile(
    r"\b(title|newspaper|magazine|subscription|delivery|citizen|monday|sunday|weeks?|times)\b",
    re.I,
)
_ORDER_SPEECH_CONTEXT = re.compile(
    r"\b(order\s*(?:number|no\.?|#)?|order\s+status|the\s+order|this\s+order|"
    r"shipping|shipped|fulfilled|unfulfilled|tracking|"
    r"which\s+book|what.?s?\s+the\s+title|book\s+in\s+(?:the|this)\s+order|"
    r"total\s+price|how\s+much)\b",
    re.I,
)
_QUANTITY_COPY_PAT = re.compile(
    r"\b(?:just\s+|need\s+)?(?:\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten)\s+"
    r"cop(?:y|ies)\b",
    re.I,
)


def payment_email_context_active(session: "SessionState", turn_mode: str = "") -> bool:
    """True when caller is in email/order capture — never treat speech as ISBN."""
    if getattr(session, "awaiting_not_found_escalation_email", False):
        return True
    if (turn_mode or "").strip().lower() == "email":
        return True
    pfs = getattr(session, "payment_flow_status", "idle") or "idle"
    if pfs in ("awaiting_email", "awaiting_email_confirmation", "awaiting_send_confirmation"):
        return True
    if getattr(session, "awaiting_payment_email", False):
        return True
    if getattr(session, "awaiting_payment_email_confirmation", False):
        return True
    from .order_flow_state import (
        STATUS_AWAITING_ORDER_NUMBER,
        STATUS_AWAITING_ORDER_VERIFICATION,
    )

    ofs = getattr(session, "order_flow_status", "idle") or "idle"
    if ofs in (STATUS_AWAITING_ORDER_NUMBER, STATUS_AWAITING_ORDER_VERIFICATION):
        return True
    return False


def looks_like_book_title_request(text: str) -> bool:
    """Heuristic: spoken title/periodical — not an ISBN digit stream."""
    expanded = _expand_text(text or "")
    lower = expanded.lower().strip()
    if not lower:
        return False
    if re.search(r"\bisbn\b", lower):
        return False
    if _ANOTHER_BOOK_INTENT_PAT.search(lower) and not _TITLE_NOT_ISBN_PAT.search(lower):
        return False
    if _META_BOOK_PHRASE_PAT.search(lower) and not _TITLE_NOT_ISBN_PAT.search(lower):
        return False
    if re.search(r"\b(it'?s a title|the title is|another title|book title)\b", lower):
        return True
    letters = sum(1 for c in lower if c.isalpha())
    digits = sum(1 for c in lower if c.isdigit())
    words = [w for w in re.split(r"\s+", lower) if w]
    if len(words) >= 6 and letters >= 12 and digits <= 2:
        return True
    if _TITLE_NOT_ISBN_PAT.search(lower) and letters > digits * 2:
        return True
    return False


def catalog_hit_is_orderable(hit: dict[str, Any]) -> bool:
    """True when Shopify returned a variant that can be added to cart."""
    if not hit or not hit.get("variant_id"):
        return False
    if hit.get("available") is False:
        return False
    inv = hit.get("inventory_quantity")
    if inv is not None:
        try:
            if int(inv) <= 0:
                return False
        except (TypeError, ValueError):
            pass
    return True


def catalog_title_search_allowed(
    session: "SessionState",
    turn_mode: str = "",
) -> bool:
    """Title/magazine/newspaper catalog search — not during order/payment/email capture."""
    if payment_email_context_active(session, turn_mode):
        return False
    if getattr(session, "awaiting_not_found_escalation_email", False):
        return False
    from .order_flow_state import (
        STATUS_AWAITING_ORDER_NUMBER,
        STATUS_AWAITING_ORDER_VERIFICATION,
    )

    ofs = getattr(session, "order_flow_status", "idle") or "idle"
    if ofs in (STATUS_AWAITING_ORDER_NUMBER, STATUS_AWAITING_ORDER_VERIFICATION):
        return False
    try:
        from .workflow_isolation import payment_workflow_active

        if payment_workflow_active(session):
            return False
    except Exception:  # noqa: BLE001
        pass
    return True


def should_skip_isbn_short_circuit(
    session: "SessionState",
    text: str,
    *,
    turn_mode: str = "",
) -> bool:
    if payment_email_context_active(session, turn_mode):
        session.pending_isbn_buffer = ""
        return True
    if turn_mode == "isbn":
        return False
    status = getattr(session, "commerce_flow_status", "idle") or "idle"
    if status == "awaiting_another_book" and (
        looks_like_book_title_request(text) or _ANOTHER_BOOK_INTENT_PAT.search(text or "")
    ):
        session.pending_isbn_buffer = ""
        return True
    if looks_like_book_title_request(text) and not getattr(session, "pending_isbn_buffer", ""):
        return True
    return False


@dataclass
class IsbnShortCircuitResult:
    force_reply: str
    isbn: str = ""
    tool_results: list[tuple[str, dict]] | None = None


def _expand_text(text: str) -> str:
    from ..tools.isbn import expand_spoken_repeaters

    return expand_spoken_repeaters(text or "")


def arm_isbn_digit_collection(session: "SessionState") -> None:
    """Caller was invited to read an ISBN — keep digit collection active."""
    session.pending_isbn_buffer = getattr(session, "pending_isbn_buffer", "") or ""
    try:
        from .conversation_state_machine import get_conversation_state

        cs = get_conversation_state(session.call_sid)
        cs.mode = "isbn_collection"
        cs.expected_next = "isbn"
    except Exception:  # noqa: BLE001
        pass


def _looks_like_isbn_digit_stream(text: str) -> bool:
    from ..tools.isbn_validator import extract_digits

    digits = extract_digits(text or "")
    return len(digits) >= 10 and digits.startswith(("978", "979"))


def _isbn_collection_active(session: "SessionState", turn_mode: str = "") -> bool:
    if turn_mode == "isbn":
        return True
    try:
        from .conversation_state_machine import get_conversation_state

        cs = get_conversation_state(session.call_sid)
        if cs.mode in ("book_collection", "isbn_collection"):
            return True
    except Exception:  # noqa: BLE001
        pass
    status = getattr(session, "commerce_flow_status", "idle") or "idle"
    if status == "awaiting_another_book":
        return True
    if status in ("awaiting_book_confirm", "awaiting_quantity", "idle"):
        if getattr(session, "commerce_pending_candidate", None):
            return False
    return bool(getattr(session, "pending_isbn_buffer", ""))


def should_skip_isbn_digit_collection(
    session: "SessionState",
    caller_text: str,
    *,
    turn_mode: str = "",
) -> bool:
    """Do not treat order numbers or copy counts as ISBN digit streams."""
    if (turn_mode or "").strip().lower() == "isbn":
        return False
    if payment_email_context_active(session, turn_mode):
        return True

    text = (caller_text or "").strip()
    if not text:
        return True
    if _ORDER_SPEECH_CONTEXT.search(text):
        return True
    if _QUANTITY_COPY_PAT.search(text):
        return True

    try:
        from .order_flow_state import order_intent_detected

        if order_intent_detected(text):
            return True
    except Exception:  # noqa: BLE001
        pass

    order_flow = getattr(session, "order_flow_status", "idle") or "idle"
    if order_flow not in ("idle", ""):
        return True

    status = getattr(session, "commerce_flow_status", "idle") or "idle"
    if status in (
        "awaiting_quantity",
        "awaiting_add_confirm",
        "awaiting_another_book",
        "awaiting_email_collection",
    ):
        if re.search(r"\bisbn\b", text, re.I):
            return False
        if _looks_like_isbn_digit_stream(text):
            return False
        return True

    return False


def prepare_isbn_turn_context(
    session: "SessionState",
    caller_text: str,
    *,
    turn_mode: str = "",
) -> Optional[str]:
    """
    Deterministic ISBN resolution for LLM-only mode.

    Updates session buffers and conversation mode but does NOT speak — the LLM
    composes the customer-facing reply from tool results.
    """
    from ..conversation.call_memory import record_isbn

    if should_skip_isbn_digit_collection(session, caller_text, turn_mode=turn_mode):
        buf = getattr(session, "pending_isbn_buffer", "") or ""
        if buf and len(buf) < 10 and turn_mode != "isbn":
            session.pending_isbn_buffer = ""
        return None

    isbn, buf = resolve_spoken_isbn(
        caller_text,
        session=session,
        turn_mode=turn_mode,
    )
    sid = (getattr(session, "call_sid", "") or "")[:6]

    try:
        from .conversation_state_machine import get_conversation_state

        cs = get_conversation_state(session.call_sid)
    except Exception:  # noqa: BLE001
        cs = None

    if isbn:
        session.pending_isbn_buffer = ""
        session.last_resolved_isbn_for_turn = isbn
        record_isbn(session, isbn)
        if cs is not None:
            cs.mode = "book_collection"
            cs.expected_next = "quantity"
        logger.info(
            "isbn_turn_context_resolved sid=%s isbn=%s turn_mode=%s",
            sid,
            isbn,
            turn_mode or "normal",
        )
        return isbn

    session.last_resolved_isbn_for_turn = ""
    if buf:
        if cs is not None:
            cs.mode = "isbn_collection"
        logger.info(
            "isbn_turn_context_buffer sid=%s digits=%d turn_mode=%s",
            sid,
            len(buf),
            turn_mode or "normal",
        )
    return None


def isbn_context_for_state_block(
    session: "SessionState",
    caller_text: str,
    *,
    turn_mode: str = "",
) -> Optional[str]:
    """Human-readable ISBN hint for the LLM system state block."""
    resolved = getattr(session, "last_resolved_isbn_for_turn", "") or ""
    if resolved:
        return (
            f"- Resolved ISBN from caller speech: {resolved}. "
            f"Call search_product_by_isbn immediately with isbn=\"{resolved}\" — do NOT ask "
            f"the caller to repeat the ISBN unless the tool returns not found."
        )
    buf = getattr(session, "pending_isbn_buffer", "") or ""
    if buf:
        need = max(0, 13 - len(buf))
        return (
            f"- ISBN digit buffer: {len(buf)} digits collected ({buf}). "
            f"Need {need} more digit(s) before catalog_search."
        )
    if turn_mode == "isbn" and caller_text.strip():
        return (
            "- Caller is reading an ISBN. Use catalog_search only after a full "
            "checksum-valid 13-digit ISBN is resolved."
        )
    return None


def normalize_catalog_search_query(
    query: str,
    session: "SessionState | None" = None,
) -> tuple[str, Optional[str]]:
    """
    Normalize catalog_search query — never pass partial 978… fragments to Shopify.

    Returns (query_for_search, resolved_isbn_or_none).
    """
    from ..tools.isbn_validator import _sliding_window_isbn13, extract_digits
    from ..tools.isbn import extract_isbn_candidate

    raw = (query or "").strip()
    if not raw:
        return raw, None

    isbn = extract_isbn_candidate(raw)
    if isbn:
        return isbn, isbn

    if session is not None:
        resolved, _buf = resolve_spoken_isbn(raw, session=session, turn_mode="isbn")
        if resolved:
            return resolved, resolved

    digits = extract_digits(raw)
    if len(digits) >= 13:
        found = _sliding_window_isbn13(digits)
        if found:
            return found, found

    return raw, None


def resolve_spoken_isbn(
    text: str,
    *,
    session: "SessionState | None" = None,
    turn_mode: str = "",
) -> tuple[Optional[str], str]:
    """
    Return (isbn_or_none, pending_buffer).

    Uses checksum-valid extraction first, then accumulates partial digits
    across turns via ``session.pending_isbn_buffer``.
    """
    from ..tools.isbn_validator import extract_digits, process_isbn_buffer
    from ..tools.isbn import extract_isbn_candidate

    expanded = _expand_text(text)
    isbn = extract_isbn_candidate(expanded)
    if isbn:
        if session is not None:
            session.pending_isbn_buffer = ""
        return isbn, ""

    from ..tools.isbn_validator import _sliding_window_isbn13, extract_digits

    all_digits = extract_digits(expanded)
    if len(all_digits) >= 13:
        found = _sliding_window_isbn13(all_digits)
        if found:
            if session is not None:
                session.pending_isbn_buffer = ""
            return found, ""

    buf = ""
    if session is not None:
        buf = getattr(session, "pending_isbn_buffer", "") or ""

    collecting = bool(buf) or turn_mode == "isbn" or (
        session is not None and _isbn_collection_active(session, turn_mode)
    )
    if not collecting and not re.search(
        r"\b(isbn|iouspl|ouspl|iuspl|digit)\b", expanded, re.I,
    ):
        digits_only = extract_digits(expanded)
        if len(digits_only) < 10:
            return None, buf
        if not digits_only.startswith(("978", "979")):
            return None, buf

    result = process_isbn_buffer(expanded, buf)
    if session is not None:
        session.pending_isbn_buffer = result.buffer

    if result.action == "complete" and result.isbn:
        if session is not None:
            session.pending_isbn_buffer = ""
        return result.isbn, ""

    if collecting and result.action in ("ask_remaining", "accumulating", "ask_repeat"):
        return None, result.buffer

    return None, result.buffer


def isbn_partial_reply(session: "SessionState", text: str, turn_mode: str = "") -> Optional[str]:
    """Deterministic prompt while digits are still being collected."""
    from ..tools.isbn_validator import process_isbn_buffer

    if turn_mode != "isbn" and not _isbn_collection_active(session, turn_mode):
        return None

    buf = getattr(session, "pending_isbn_buffer", "") or ""
    result = process_isbn_buffer(_expand_text(text), buf)
    session.pending_isbn_buffer = result.buffer

    if result.action == "complete":
        return None

    if result.action == "ask_remaining" and result.message:
        return result.message
    if result.action == "ask_repeat" and result.message:
        return result.message

    digits = "".join(c for c in text if c.isdigit())
    if 10 <= len(digits) <= 12:
        need = 13 - len(digits)
        return (
            f"I have {len(digits)} digits so far. "
            f"Please give me the last {need} digit{'s' if need != 1 else ''}."
        )
    return None


async def try_isbn_short_circuit(
    session: "SessionState",
    caller_text: str,
    *,
    turn_mode: str = "",
) -> Optional[IsbnShortCircuitResult]:
    """
    Run catalog search on a resolved ISBN and return a spoken reply, or None.
    """
    if should_skip_isbn_short_circuit(session, caller_text, turn_mode=turn_mode):
        return None

    if (turn_mode or "").lower() == "isbn":
        pass
    elif re.search(r"\b(it'?s|this is)\s+(?:an?\s+)?isbn\b", caller_text or "", re.I):
        session.pending_isbn_buffer = getattr(session, "pending_isbn_buffer", "") or ""
        arm_isbn_digit_collection(session)

    from .commerce_flow_state import normalize_catalog_hit, quantity_prompt, stage_product_candidate
    from ..tools import shopify_tools as shopify_st
    from ..conversation.call_memory import record_isbn

    expanded = _expand_text(caller_text)
    isbn, _buf = resolve_spoken_isbn(
        expanded,
        session=session,
        turn_mode=turn_mode,
    )

    if not isbn:
        partial = isbn_partial_reply(session, caller_text, turn_mode=turn_mode)
        if partial and (turn_mode == "isbn" or _isbn_collection_active(session, turn_mode)):
            return IsbnShortCircuitResult(force_reply=partial)
        if turn_mode == "isbn" or _looks_like_isbn_digit_stream(caller_text):
            buf = getattr(session, "pending_isbn_buffer", "") or ""
            if buf:
                need = max(0, 13 - len(buf))
                return IsbnShortCircuitResult(
                    force_reply=(
                        f"I have {len(buf)} digits so far. "
                        f"Please give me the next {need} digit{'s' if need != 1 else ''}."
                    ),
                )
            return IsbnShortCircuitResult(
                force_reply=(
                    "Go ahead with the full 13-digit ISBN when you're ready — "
                    "I'll look it up as soon as I have the complete number."
                ),
            )
        return None

    sid = (session.call_sid or "")[:6]
    logger.info(
        "isbn_short_circuit sid=%s isbn=%s turn_mode=%s version=%s",
        sid,
        isbn,
        turn_mode or "normal",
        ISBN_SHORT_CIRCUIT_VERSION,
    )

    record_isbn(session, isbn)
    raw = await shopify_st.search_product_by_isbn(isbn)
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        payload = {}

    tool_results: list[tuple[str, dict]] = [
        ("search_product_by_isbn", payload if isinstance(payload, dict) else {}),
    ]

    if isinstance(payload, dict) and payload.get("needs_more_digits"):
        return IsbnShortCircuitResult(
            force_reply=payload.get("customer_message") or (
                "I have part of it. Please continue with the remaining digits."
            ),
            isbn=isbn,
            tool_results=tool_results,
        )

    if isinstance(payload, dict) and payload.get("found") and payload.get("product"):
        product = payload["product"]
        top = normalize_catalog_hit({
            "id": product.get("product_id"),
            "title": product.get("title"),
            "price": product.get("price"),
            "available": product.get("available"),
            "author": product.get("author"),
            "inventory_quantity": product.get("inventory_quantity"),
            "variants": [{"id": product.get("variant_id"), "price": product.get("price")}],
        })
        if not catalog_hit_is_orderable(top):
            from .not_found_escalation_flow import begin_unavailable_product_handoff

            title = (top.get("title") or product.get("title") or "").strip()
            msg = begin_unavailable_product_handoff(
                session,
                user_text=caller_text,
                query=isbn,
                reason="product_out_of_stock",
                search_result=payload if isinstance(payload, dict) else {},
                product_title=title,
            )
            return IsbnShortCircuitResult(
                force_reply=msg,
                isbn=isbn,
                tool_results=tool_results,
            )
        if top.get("variant_id"):
            stage_product_candidate(session, top)
            try:
                from .conversation_state_machine import get_conversation_state

                cs = get_conversation_state(session.call_sid)
                cs.mode = "book_collection"
                cs.expected_next = "quantity"
            except Exception:  # noqa: BLE001
                pass
            spoken = payload.get("customer_message") or quantity_prompt(top)
            return IsbnShortCircuitResult(
                force_reply=spoken,
                isbn=isbn,
                tool_results=tool_results,
            )
        title = (top.get("title") or "").strip()
        if title:
            session.last_product_candidate = top
            spoken = payload.get("customer_message") or (
                f"I found {title}. How many copies would you like?"
            )
            return IsbnShortCircuitResult(
                force_reply=spoken,
                isbn=isbn,
                tool_results=tool_results,
            )

    from .not_found_escalation_flow import begin_unavailable_product_handoff

    not_found_msg = begin_unavailable_product_handoff(
        session,
        user_text=caller_text,
        query=isbn,
        reason="product_not_found",
        search_result=payload if isinstance(payload, dict) else {},
    )
    return IsbnShortCircuitResult(
        force_reply=not_found_msg,
        isbn=isbn,
        tool_results=tool_results,
    )


async def try_title_catalog_short_circuit(
    session: "SessionState",
    caller_text: str,
    *,
    turn_mode: str = "",
) -> Optional[IsbnShortCircuitResult]:
    """Catalog search when the caller speaks a title, magazine, or newspaper name."""
    if not catalog_title_search_allowed(session, turn_mode):
        return None
    if turn_mode == "isbn":
        return None

    from .commerce_flow_state import (
        STATUS_AWAITING_ADD_CONFIRM,
        STATUS_AWAITING_BOOK_CONFIRM,
        STATUS_AWAITING_QUANTITY,
        STATUS_AWAITING_ANOTHER_BOOK,
        STATUS_IDLE,
    )

    status = getattr(session, "commerce_flow_status", "idle") or "idle"
    text = (caller_text or "").strip()

    if status in (
        STATUS_AWAITING_QUANTITY,
        STATUS_AWAITING_BOOK_CONFIRM,
        STATUS_AWAITING_ADD_CONFIRM,
    ):
        if not looks_like_book_title_request(text):
            return None
    elif status not in (STATUS_IDLE, STATUS_AWAITING_ANOTHER_BOOK, ""):
        return None

    if _ANOTHER_BOOK_INTENT_PAT.search(text) and not looks_like_book_title_request(text):
        return IsbnShortCircuitResult(
            force_reply="Sure — what's the ISBN or title of the next book?",
        )
    if not looks_like_book_title_request(caller_text):
        return None

    from .commerce_flow_state import normalize_catalog_hit, quantity_prompt, stage_product_candidate
    from .llm_tools import CatalogSearchArgs, _catalog_search
    from .not_found_escalation_flow import begin_unavailable_product_handoff
    from ..conversation.call_memory import record_product_candidate

    session.pending_isbn_buffer = ""
    query = caller_text.strip()
    raw = await _catalog_search(
        CatalogSearchArgs(query=query, limit=5),
        session,
    )
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        payload = {}

    tool_results: list[tuple[str, dict]] = [
        ("catalog_search", payload if isinstance(payload, dict) else {}),
    ]
    results = (payload.get("results") or []) if isinstance(payload, dict) else []
    if results and isinstance(results[0], dict):
        top = normalize_catalog_hit(results[0])
        record_product_candidate(session, title=top.get("title") or "", found=True)
        if top.get("variant_id") and not catalog_hit_is_orderable(top):
            title = (top.get("title") or "").strip()
            msg = begin_unavailable_product_handoff(
                session,
                user_text=caller_text,
                query=query,
                reason="product_out_of_stock",
                search_result={"results": results[:3], "count": len(results)},
                product_title=title,
            )
            return IsbnShortCircuitResult(force_reply=msg, tool_results=tool_results)
        if top.get("variant_id"):
            stage_product_candidate(session, top)
            return IsbnShortCircuitResult(
                force_reply=quantity_prompt(top),
                tool_results=tool_results,
            )

    record_product_candidate(session, title=query[:80], found=False)
    msg = begin_unavailable_product_handoff(
        session,
        user_text=caller_text,
        query=query,
        reason="product_not_found",
        search_result={"results": [], "count": 0},
    )
    return IsbnShortCircuitResult(
        force_reply=msg,
        tool_results=tool_results,
    )


def is_conversational_ack(text: str) -> bool:
    return bool(
        re.match(
            r"^\s*(okay|ok|i am good|i'm good|i'm doing good|doing good|"
            r"sure|alright|got it|sounds good)\s*\.?\s*$",
            (text or "").strip(),
            re.I,
        )
    )


def conversational_ack_reply(session: "SessionState", turn_mode: str = "") -> Optional[str]:
    """Short ack during book lookup — never offer payment link with an empty cart."""
    from .commerce_flow_state import commerce_flow_active
    from .payment_flow_state import _cart_has_confirmed_items

    if _cart_has_confirmed_items(session) or commerce_flow_active(session):
        return None
    if getattr(session, "awaiting_payment_email", False):
        return None
    if _isbn_collection_active(session, turn_mode):
        return "Sure! Go ahead with the ISBN whenever you're ready."
    return "Great! Tell me the ISBN, title, or author of the book you're looking for."
