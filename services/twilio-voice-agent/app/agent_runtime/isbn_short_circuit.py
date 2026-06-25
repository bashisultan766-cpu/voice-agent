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

ISBN_SHORT_CIRCUIT_VERSION = "v4.37"

_TITLE_NOT_ISBN_PAT = re.compile(
    r"\b(title|newspaper|magazine|subscription|delivery|citizen|monday|sunday|weeks?)\b",
    re.I,
)


def looks_like_book_title_request(text: str) -> bool:
    """Heuristic: spoken title/periodical — not an ISBN digit stream."""
    expanded = _expand_text(text or "")
    lower = expanded.lower().strip()
    if not lower:
        return False
    if re.search(r"\bisbn\b", lower):
        return False
    if re.search(r"\b(it'?s a title|the title is|another title|book title)\b", lower):
        return True
    letters = sum(1 for c in lower if c.isalpha())
    digits = sum(1 for c in lower if c.isdigit())
    words = [w for w in re.split(r"\s+", lower) if w]
    if len(words) >= 4 and letters >= 12 and digits <= 2:
        return True
    if _TITLE_NOT_ISBN_PAT.search(lower) and letters > digits * 2:
        return True
    return False


def should_skip_isbn_short_circuit(
    session: "SessionState",
    text: str,
    *,
    turn_mode: str = "",
) -> bool:
    if turn_mode == "isbn":
        return False
    status = getattr(session, "commerce_flow_status", "idle") or "idle"
    if status == "awaiting_another_book" and looks_like_book_title_request(text):
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
    if status in ("awaiting_book_confirm", "awaiting_quantity", "idle"):
        if getattr(session, "commerce_pending_candidate", None):
            return False
    return bool(getattr(session, "pending_isbn_buffer", ""))


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
    from ..pipeline.isbn_validator import extract_digits, process_isbn_buffer
    from ..tools.isbn import extract_isbn_candidate

    expanded = _expand_text(text)
    isbn = extract_isbn_candidate(expanded)
    if isbn:
        if session is not None:
            session.pending_isbn_buffer = ""
        return isbn, ""

    from ..pipeline.isbn_validator import _sliding_window_isbn13, extract_digits

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

    collecting = turn_mode == "isbn" or (
        session is not None and _isbn_collection_active(session, turn_mode)
    )
    if not collecting and not re.search(r"\b(isbn|digit)\b", expanded, re.I):
        digits_only = extract_digits(expanded)
        if len(digits_only) not in (10, 13):
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
    from ..pipeline.isbn_validator import process_isbn_buffer

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

    from .commerce_flow_state import normalize_catalog_hit, quantity_prompt, stage_product_candidate
    from .llm_tools import CatalogSearchArgs, _catalog_search
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
    raw = await _catalog_search(CatalogSearchArgs(query=isbn, limit=5), session)
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        payload = {}

    tool_results: list[tuple[str, dict]] = [("catalog_search", payload if isinstance(payload, dict) else {})]

    results = (payload.get("results") or []) if isinstance(payload, dict) else []
    if results and isinstance(results[0], dict):
        top = normalize_catalog_hit(results[0])
        if top.get("variant_id"):
            stage_product_candidate(session, top)
            try:
                from .conversation_state_machine import get_conversation_state

                cs = get_conversation_state(session.call_sid)
                cs.mode = "book_collection"
                cs.expected_next = "quantity"
            except Exception:  # noqa: BLE001
                pass
            return IsbnShortCircuitResult(
                force_reply=quantity_prompt(top),
                isbn=isbn,
                tool_results=tool_results,
            )
        title = (top.get("title") or "").strip()
        if title:
            session.last_product_candidate = top
            return IsbnShortCircuitResult(
                force_reply=(
                    f"I found {title}. How many copies would you like?"
                ),
                isbn=isbn,
                tool_results=tool_results,
            )

    return IsbnShortCircuitResult(
        force_reply=(
            f"I looked up ISBN {isbn} but couldn't find a match in our catalog. "
            "Could you double-check the number, or give me the title or author instead?"
        ),
        isbn=isbn,
        tool_results=tool_results,
    )


async def try_title_catalog_short_circuit(
    session: "SessionState",
    caller_text: str,
    *,
    turn_mode: str = "",
) -> Optional[IsbnShortCircuitResult]:
    """Catalog search when the caller speaks a title (not digits) for the next book."""
    if turn_mode == "isbn":
        return None
    status = getattr(session, "commerce_flow_status", "idle") or "idle"
    if status != "awaiting_another_book":
        return None
    if not looks_like_book_title_request(caller_text):
        return None

    from .commerce_flow_state import normalize_catalog_hit, quantity_prompt, stage_product_candidate
    from .llm_tools import CatalogSearchArgs, _catalog_search

    session.pending_isbn_buffer = ""
    raw = await _catalog_search(
        CatalogSearchArgs(query=caller_text.strip(), limit=5),
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
        if top.get("variant_id"):
            stage_product_candidate(session, top)
            return IsbnShortCircuitResult(
                force_reply=quantity_prompt(top),
                tool_results=tool_results,
            )

    return IsbnShortCircuitResult(
        force_reply=(
            "I didn't find that title in our catalog yet. "
            "Could you spell part of the title, or give me the ISBN?"
        ),
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
