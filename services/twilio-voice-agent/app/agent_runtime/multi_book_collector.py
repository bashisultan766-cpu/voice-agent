"""MultiBookCollector — collect multiple ISBNs/titles across voice turns (v4.14.6)."""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Optional

from .business_intent_resolver import extract_isbn_from_text
from .commerce_session import (
    CommerceSession,
    get_last_selected_or_best_candidate,
    save_commerce_session,
)
from .tool_entity_extractor import extract_all_isbns

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_MIN_ISBN_DIGITS = 10


@dataclass
class BookIdentifier:
    type: str  # isbn | title | author | subject
    value: str
    source_text: str
    status: str = "pending"  # pending | searched | found | not_found | added | skipped
    candidate_id: str | None = None


def _short_sid(sid: str) -> str:
    return sid[:6] if sid else "?"


def _digits_only(text: str) -> str:
    return re.sub(r"\D", "", text or "")


def _is_complete_isbn(digits: str) -> bool:
    return len(digits) in (10, 13)


def enter_multi_book_mode(
    session: CommerceSession,
    *,
    requested_count: int | None = None,
) -> str:
    session.multi_book_mode = True
    session.requested_cart_count = requested_count
    session.expected_next = "multi_isbn_or_title"
    session.collected_identifiers = []
    session.pending_identifier_buffer = ""
    session.current_identifier_type = "unknown"
    session.current_identifier_digits = ""
    save_commerce_session(session)
    return "Got it. Give me the first ISBN or title."


def _append_identifier(session: CommerceSession, identifier: BookIdentifier) -> None:
    session.collected_identifiers.append(identifier)


def _partial_isbn_response(digits: str) -> str:
    spaced = " ".join(digits)
    return f"I have {spaced} so far. Please continue with the next digits."


def _count_target(session: CommerceSession) -> int | None:
    return session.requested_cart_count


def _books_collected(session: CommerceSession) -> int:
    return sum(1 for i in session.collected_identifiers if i.status in {"added", "found"})


def _should_continue(session: CommerceSession) -> bool:
    target = _count_target(session)
    if target is None:
        return True
    return _books_collected(session) < target


def handle_multi_book_turn(
    text: str,
    session: CommerceSession,
    *,
    session_state: Optional["SessionState"] = None,
):
    """Process a turn while multi_book_mode is active."""
    from .commerce_commit_resolver import CommerceCommitResult

    unresolved = CommerceCommitResult(
        matched=False,
        intent="unknown",
        action=None,
        direct_answer=None,
        expected_next=None,
        selected_candidate_id=None,
        quantity=1,
        needs_next_book=False,
        needs_payment=False,
        reason="no_match",
    )

    digits_in_turn = _digits_only(text)
    complete_isbn = extract_isbn_from_text(text)

    # Partial ISBN accumulation
    if digits_in_turn and not complete_isbn:
        combined = session.current_identifier_digits + digits_in_turn
        session.current_identifier_digits = combined
        session.current_identifier_type = "isbn"
        session.pending_identifier_buffer = combined
        save_commerce_session(session)
        if not _is_complete_isbn(combined):
            return CommerceCommitResult(
                matched=True,
                intent="isbn_partial",
                action="buffer_isbn",
                direct_answer=_partial_isbn_response(combined),
                expected_next="isbn_number",
                selected_candidate_id=session.selected_candidate_id,
                quantity=1,
                needs_next_book=True,
                needs_payment=False,
                reason="partial_isbn",
            )
        complete_isbn = combined
        session.current_identifier_digits = ""
        session.pending_identifier_buffer = ""

    if complete_isbn:
        identifier = BookIdentifier(
            type="isbn",
            value=complete_isbn,
            source_text=text,
            status="pending",
        )
        _append_identifier(session, identifier)
        save_commerce_session(session)
        return _search_and_add_identifier(session, identifier, session_state=session_state)

    # Treat as title if not digits-only fragment
    if len(text.strip()) >= 3 and not digits_in_turn:
        identifier = BookIdentifier(
            type="title",
            value=text.strip(),
            source_text=text,
            status="pending",
        )
        _append_identifier(session, identifier)
        save_commerce_session(session)
        return _search_and_add_identifier(session, identifier, session_state=session_state)

    return unresolved


def _search_and_add_identifier(
    session: CommerceSession,
    identifier: BookIdentifier,
    *,
    session_state: Optional["SessionState"] = None,
):
    """Mark identifier for tool search — returns needs_tools for ISBN/title lookup."""
    from .commerce_commit_resolver import CommerceCommitResult

    if identifier.type == "isbn":
        return CommerceCommitResult(
            matched=True,
            intent="isbn_lookup",
            action="search_isbn",
            direct_answer=None,
            expected_next="multi_isbn_or_title",
            selected_candidate_id=session.selected_candidate_id,
            quantity=1,
            needs_next_book=True,
            needs_payment=False,
            reason="multi_book_isbn_search",
            tool_categories=["isbn_lookup", "catalog_search"],
            response_mode="needs_tools",
        )

    return CommerceCommitResult(
        matched=True,
        intent="book_title_search",
        action="search_title",
        direct_answer=None,
        expected_next="multi_isbn_or_title",
        selected_candidate_id=session.selected_candidate_id,
        quantity=1,
        needs_next_book=True,
        needs_payment=False,
        reason="multi_book_title_search",
        tool_categories=["catalog_search"],
        response_mode="needs_tools",
    )


def after_product_found_in_multi_mode(
    session: CommerceSession,
    *,
    title: str,
    price: str | None = None,
    auto_add: bool = False,
    session_state: Optional["SessionState"] = None,
):
    """Called after product search succeeds during multi-book collection."""
    from .cart_orchestrator import add_candidate_to_cart
    from .commerce_commit_resolver import CommerceCommitResult

    candidate = get_last_selected_or_best_candidate(session)
    if not candidate:
        return CommerceCommitResult(
            matched=True,
            intent="multi_book_not_found",
            action=None,
            direct_answer=(
                "I don't see that ISBN listed right now. I can take your email for customer service, "
                "or you can give me another ISBN."
            ),
            expected_next="multi_isbn_or_title",
            selected_candidate_id=None,
            quantity=0,
            needs_next_book=True,
            needs_payment=False,
            reason="not_found",
        )

    if auto_add or session.requested_cart_count:
        result = add_candidate_to_cart(session, candidate.candidate_id, session_state=session_state)
        if result.get("success"):
            if identifier := _last_pending_identifier(session):
                identifier.status = "added"
                identifier.candidate_id = candidate.candidate_id

            if _should_continue(session):
                price_part = f" for {price}" if price else (f" for {candidate.price}" if candidate.price else "")
                return CommerceCommitResult(
                    matched=True,
                    intent="multi_book_added",
                    action="add_and_continue",
                    direct_answer=(
                        f"I found {candidate.title}{price_part}. I added it to your order. "
                        "Please give me the next ISBN or title."
                    ),
                    expected_next="multi_isbn_or_title",
                    selected_candidate_id=candidate.candidate_id,
                    quantity=1,
                    needs_next_book=True,
                    needs_payment=False,
                    reason="added_continue",
                )

            titles = [ln.title for ln in session.active_cart if ln.status == "active"]
            joined = ", ".join(titles)
            count = len(titles)
            return CommerceCommitResult(
                matched=True,
                intent="multi_book_complete",
                action="summarize",
                direct_answer=(
                    f"I have {count} books in your order: {joined}. "
                    "Should I send the payment link for these?"
                ),
                expected_next="cart_confirm",
                selected_candidate_id=candidate.candidate_id,
                quantity=count,
                needs_next_book=False,
                needs_payment=True,
                reason="collection_complete",
            )

    price_part = f" for {candidate.price}" if candidate.price else ""
    return CommerceCommitResult(
        matched=True,
        intent="multi_book_found",
        action="offer_add",
        direct_answer=f"I found {candidate.title}{price_part}. Should I add it to your order?",
        expected_next="confirm_add",
        selected_candidate_id=candidate.candidate_id,
        quantity=1,
        needs_next_book=True,
        needs_payment=False,
        reason="found_offer",
    )


def _last_pending_identifier(session: CommerceSession) -> BookIdentifier | None:
    for ident in reversed(session.collected_identifiers):
        if ident.status == "pending":
            ident.status = "found"
            return ident
    return None


def handle_multiple_isbns(
    text: str,
    session: CommerceSession,
    isbns: list[str],
    *,
    session_state: Optional["SessionState"] = None,
):
    """Detect multiple ISBNs in one utterance."""
    from .commerce_commit_resolver import CommerceCommitResult

    for isbn in isbns:
        _append_identifier(
            session,
            BookIdentifier(type="isbn", value=isbn, source_text=text, status="pending"),
        )
    save_commerce_session(session)

    if len(isbns) == 2:
        return CommerceCommitResult(
            matched=True,
            intent="multi_isbn_detected",
            action="search_multiple",
            direct_answer=None,
            expected_next="confirm_add_both",
            selected_candidate_id=session.selected_candidate_id,
            quantity=2,
            needs_next_book=False,
            needs_payment=False,
            reason="two_isbns_detected",
            tool_categories=["isbn_lookup", "catalog_search"],
            response_mode="needs_tools",
        )

    session.multi_book_mode = True
    session.requested_cart_count = len(isbns)
    return CommerceCommitResult(
        matched=True,
        intent="multi_isbn_detected",
        action="search_multiple",
        direct_answer=f"Got it. I'll look up {len(isbns)} ISBNs one at a time.",
        expected_next="multi_isbn_or_title",
        selected_candidate_id=session.selected_candidate_id,
        quantity=len(isbns),
        needs_next_book=True,
        needs_payment=False,
        reason="multiple_isbns",
        tool_categories=["isbn_lookup", "catalog_search"],
        response_mode="needs_tools",
    )
