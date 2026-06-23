"""CommerceCommitResolver — commitment memory before LLM/catalog search (v4.14.6)."""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Optional

from .commerce_session import (
    CommerceSession,
    get_last_selected_or_best_candidate,
    save_commerce_session,
)
from .tool_entity_extractor import (
    extract_all_isbns,
    extract_ordinal_selection,
    extract_product_identifiers,
    is_add_all_phrase,
    is_cart_summary_question,
    is_commerce_control_phrase,
    is_payment_link_phrase,
    is_strong_add_commitment,
    is_add_and_next_book_phrase,
    is_multi_book_declaration,
    is_rejection_phrase,
)

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_WHITESPACE = re.compile(r"\s+")


@dataclass
class CommerceCommitResult:
    matched: bool
    intent: str
    action: str | None
    direct_answer: str | None
    expected_next: str | None
    selected_candidate_id: str | None
    quantity: int
    needs_next_book: bool
    needs_payment: bool
    reason: str
    tool_categories: list[str] | None = None
    response_mode: str = "direct_answer"


def _norm(text: str) -> str:
    return _WHITESPACE.sub(" ", (text or "").strip())


def _short_sid(sid: str) -> str:
    return sid[:6] if sid else "?"


def _title_safe(title: str, max_len: int = 40) -> str:
    clean = re.sub(r"[^\w\s\-',.:]+", "", (title or "").strip())
    return (clean[:max_len] + "...") if len(clean) > max_len else clean


def _agent_offered_add(commerce: CommerceSession, session_state: Optional["SessionState"] = None) -> bool:
    if commerce.expected_next in {
        "add_to_cart_offer",
        "add_to_cart_confirm",
        "confirm_add",
        "confirm_add_candidates",
    }:
        return True
    if session_state is not None and hasattr(session_state, "dialogue"):
        expected = getattr(session_state.dialogue, "expected_next", "") or ""
        if expected in {
            "add_to_cart_offer",
            "add_to_cart_confirm",
            "confirm_add",
            "confirm_add_candidates",
        }:
            return True
    if commerce.last_product_answer and "add it to your order" in commerce.last_product_answer.lower():
        return True
    return bool(commerce.selected_candidate_id or commerce.last_candidates)


def _add_selected(
    commerce: CommerceSession,
    session_state: Optional["SessionState"] = None,
    *,
    quantity: int = 1,
    next_book_message: str | None = None,
) -> CommerceCommitResult:
    from .cart_orchestrator import add_candidate_to_cart

    candidate = get_last_selected_or_best_candidate(commerce)
    if not candidate:
        return CommerceCommitResult(
            matched=True,
            intent="add_selected",
            action=None,
            direct_answer="Which book would you like me to add?",
            expected_next="book_identifier",
            selected_candidate_id=None,
            quantity=quantity,
            needs_next_book=False,
            needs_payment=False,
            reason="no_candidate",
        )

    result = add_candidate_to_cart(commerce, candidate.candidate_id, quantity=quantity, session_state=session_state)
    if result.get("success"):
        logger.info(
            "commerce_auto_add_selected sid=%s title_safe=%s cart_lines=%d",
            _short_sid(commerce.sid),
            _title_safe(candidate.title),
            result.get("cart_lines", 0),
        )
        message = next_book_message or result["message"]
        return CommerceCommitResult(
            matched=True,
            intent="add_selected",
            action="add_selected",
            direct_answer=message,
            expected_next="book_identifier",
            selected_candidate_id=candidate.candidate_id,
            quantity=quantity,
            needs_next_book=bool(next_book_message),
            needs_payment=False,
            reason="added",
        )

    return CommerceCommitResult(
        matched=True,
        intent="add_selected",
        action=None,
        direct_answer=result.get("message", "I couldn't add that book right now."),
        expected_next="book_identifier",
        selected_candidate_id=candidate.candidate_id,
        quantity=quantity,
        needs_next_book=False,
        needs_payment=False,
        reason="add_failed",
    )


def _add_all_candidates(
    commerce: CommerceSession,
    session_state: Optional["SessionState"] = None,
) -> CommerceCommitResult:
    from .cart_orchestrator import add_candidate_to_cart

    added_titles: list[str] = []
    for candidate in commerce.last_candidates:
        if not candidate.variant_id or candidate.availability == "out_of_stock":
            continue
        result = add_candidate_to_cart(
            commerce, candidate.candidate_id, session_state=session_state,
        )
        if result.get("success"):
            added_titles.append(candidate.title)

    if not added_titles:
        return CommerceCommitResult(
            matched=True,
            intent="add_all_candidates",
            action=None,
            direct_answer="I couldn't add those books because I don't have valid listings right now.",
            expected_next="book_identifier",
            selected_candidate_id=None,
            quantity=0,
            needs_next_book=False,
            needs_payment=False,
            reason="add_all_failed",
        )

    joined = added_titles[0] if len(added_titles) == 1 else ", ".join(added_titles[:-1]) + f", and {added_titles[-1]}"
    return CommerceCommitResult(
        matched=True,
        intent="add_all_candidates",
        action="add_all",
        direct_answer=f"I added {joined} to your order.",
        expected_next="cart_confirm",
        selected_candidate_id=commerce.selected_candidate_id,
        quantity=len(added_titles),
        needs_next_book=False,
        needs_payment=True,
        reason="added_all",
    )


def resolve_commerce_commit(
    text: str,
    session: CommerceSession,
    *,
    session_state: Optional["SessionState"] = None,
) -> CommerceCommitResult:
    """Resolve caller commitment phrases using CommerceSession before LLM/search."""
    normalized = _norm(text)
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

    if not normalized:
        return unresolved

    sid = session.sid
    candidate = get_last_selected_or_best_candidate(session)

    # Cart summary questions
    if is_cart_summary_question(normalized):
        from .cart_orchestrator import cart_summary_text, cart_count, what_did_i_add_text

        if re.search(r"what did i add|what(?:'s| is) in my", normalized, re.I):
            answer = what_did_i_add_text(session)
        else:
            answer = cart_summary_text(session)
        return CommerceCommitResult(
            matched=True,
            intent="cart_summary",
            action="summarize",
            direct_answer=answer,
            expected_next=session.expected_next,
            selected_candidate_id=session.selected_candidate_id,
            quantity=cart_count(session),
            needs_next_book=False,
            needs_payment=False,
            reason="cart_summary",
        )

    # Ordinal / title-hint selection
    selection = extract_ordinal_selection(normalized)
    if selection:
        from .cart_orchestrator import (
            add_candidate_to_cart,
            remove_cart_item_by_ordinal,
            select_candidate_by_ordinal,
            select_candidate_by_title_hint,
            skip_candidate_by_hint,
        )

        action = selection.get("action")
        if action == "add" and "ordinal" in selection:
            cid = select_candidate_by_ordinal(session, int(selection["ordinal"]))
            if cid:
                result = add_candidate_to_cart(session, cid, session_state=session_state)
                save_commerce_session(session)
                return CommerceCommitResult(
                    matched=True,
                    intent="add_ordinal",
                    action="add_selected",
                    direct_answer=result.get("message"),
                    expected_next="book_identifier",
                    selected_candidate_id=cid,
                    quantity=1,
                    needs_next_book=False,
                    needs_payment=False,
                    reason="ordinal_add",
                )
        elif action == "add" and "title_hint" in selection:
            cid = select_candidate_by_title_hint(session, str(selection["title_hint"]))
            if cid:
                result = add_candidate_to_cart(session, cid, session_state=session_state)
                save_commerce_session(session)
                return CommerceCommitResult(
                    matched=True,
                    intent="add_by_hint",
                    action="add_selected",
                    direct_answer=result.get("message"),
                    expected_next="book_identifier",
                    selected_candidate_id=cid,
                    quantity=1,
                    needs_next_book=False,
                    needs_payment=False,
                    reason="hint_add",
                )
        elif action == "remove" and "ordinal" in selection:
            result = remove_cart_item_by_ordinal(session, int(selection["ordinal"]), session_state)
            save_commerce_session(session)
            return CommerceCommitResult(
                matched=True,
                intent="remove_ordinal",
                action="remove",
                direct_answer=result.get("message"),
                expected_next=session.expected_next,
                selected_candidate_id=session.selected_candidate_id,
                quantity=0,
                needs_next_book=False,
                needs_payment=False,
                reason="ordinal_remove",
            )
        elif action == "skip" and "title_hint" in selection:
            result = skip_candidate_by_hint(session, str(selection["title_hint"]))
            save_commerce_session(session)
            return CommerceCommitResult(
                matched=True,
                intent="skip_candidate",
                action="skip",
                direct_answer=result.get("message"),
                expected_next="book_identifier",
                selected_candidate_id=None,
                quantity=0,
                needs_next_book=False,
                needs_payment=False,
                reason="hint_skip",
            )

    # Add all / add both
    if is_add_all_phrase(normalized) and session.last_candidates:
        result = _add_all_candidates(session, session_state)
        save_commerce_session(session)
        logger.info(
            "commerce_commit_resolved sid=%s intent=add_all action=add_all selected=%s next=%s",
            _short_sid(sid),
            (result.selected_candidate_id or "none")[:8],
            result.expected_next or "none",
        )
        return result

    # Multi-book collector mode takes priority when active
    if session.multi_book_mode or session.expected_next == "multi_isbn_or_title":
        from .multi_book_collector import handle_multi_book_turn

        collector_result = handle_multi_book_turn(normalized, session, session_state=session_state)
        if collector_result.matched:
            save_commerce_session(session)
            logger.info(
                "commerce_commit_resolved sid=%s intent=%s action=%s selected=%s next=%s",
                _short_sid(sid),
                collector_result.intent,
                collector_result.action or "none",
                (collector_result.selected_candidate_id or "none")[:8],
                collector_result.expected_next or "none",
            )
            return collector_result

    # Confirm adding candidates before payment
    if session.expected_next == "confirm_add_candidates" and is_strong_add_commitment(normalized):
        result = _add_all_candidates(session, session_state)
        if result.action == "add_all":
            from .payment_link_orchestrator import handle_payment_request

            pay = handle_payment_request(session, session_state=session_state)
            result.direct_answer = pay.get("message") or result.direct_answer
            result.expected_next = pay.get("expected_next")
            result.needs_payment = True
            result.response_mode = pay.get("response_mode", "direct_answer")
            result.tool_categories = pay.get("tool_categories", [])
        save_commerce_session(session)
        logger.info(
            "commerce_commit_resolved sid=%s intent=%s action=%s selected=%s next=%s",
            _short_sid(sid), result.intent, result.action or "none",
            (result.selected_candidate_id or "none")[:8], result.expected_next or "none",
        )
        return result

    # Payment link requests
    if is_payment_link_phrase(normalized):
        from .payment_link_orchestrator import handle_payment_request

        pay = handle_payment_request(session, session_state=session_state)
        logger.info(
            "commerce_commit_resolved sid=%s intent=payment_flow action=payment_request selected=%s next=%s",
            _short_sid(sid),
            (session.selected_candidate_id or "none")[:8],
            pay.get("expected_next") or "none",
        )
        return CommerceCommitResult(
            matched=True,
            intent="payment_flow",
            action="payment_request",
            direct_answer=pay.get("message"),
            expected_next=pay.get("expected_next"),
            selected_candidate_id=session.selected_candidate_id,
            quantity=1,
            needs_next_book=False,
            needs_payment=True,
            reason="payment_request",
            tool_categories=pay.get("tool_categories", []),
            response_mode=pay.get("response_mode", "direct_answer"),
        )

    # Cart confirm yes -> continue payment
    if session.expected_next == "cart_confirm" and is_strong_add_commitment(normalized):
        from .payment_link_orchestrator import handle_payment_request

        pay = handle_payment_request(session, session_state=session_state, cart_confirmed=True)
        return CommerceCommitResult(
            matched=True,
            intent="payment_flow",
            action="cart_confirmed",
            direct_answer=pay.get("message"),
            expected_next=pay.get("expected_next"),
            selected_candidate_id=session.selected_candidate_id,
            quantity=1,
            needs_next_book=False,
            needs_payment=True,
            reason="cart_confirmed",
            tool_categories=pay.get("tool_categories", []),
            response_mode=pay.get("response_mode", "direct_answer"),
        )

    # Email confirm yes
    if session.expected_next == "email_confirm" and is_strong_add_commitment(normalized):
        if session_state and getattr(session_state, "pending_email", ""):
            session_state.confirmed_email = session_state.pending_email
            session_state.pending_email = ""
        from .payment_link_orchestrator import handle_payment_request

        pay = handle_payment_request(
            session, session_state=session_state, cart_confirmed=True, email_confirmed=True,
        )
        return CommerceCommitResult(
            matched=True,
            intent="payment_flow",
            action="email_confirmed",
            direct_answer=pay.get("message"),
            expected_next=pay.get("expected_next"),
            selected_candidate_id=session.selected_candidate_id,
            quantity=1,
            needs_next_book=False,
            needs_payment=True,
            reason="email_confirmed",
            tool_categories=pay.get("tool_categories", []),
            response_mode=pay.get("response_mode", "direct_answer"),
        )

    # Email capture
    if session.expected_next == "email_capture" or (
        session_state and getattr(getattr(session_state, "dialogue", None), "expected_next", "") == "email_capture"
    ):
        from .payment_link_orchestrator import handle_payment_request, parse_spoken_email

        email = parse_spoken_email(normalized)
        if email and session_state is not None:
            session_state.pending_email = email
            pay = handle_payment_request(session, session_state=session_state, cart_confirmed=True)
            return CommerceCommitResult(
                matched=True,
                intent="payment_flow",
                action="email_captured",
                direct_answer=pay.get("message"),
                expected_next=pay.get("expected_next"),
                selected_candidate_id=session.selected_candidate_id,
                quantity=1,
                needs_next_book=False,
                needs_payment=True,
                reason="email_captured",
                tool_categories=pay.get("tool_categories", []),
                response_mode=pay.get("response_mode", "direct_answer"),
            )

    # Multi-book declaration
    multi = is_multi_book_declaration(normalized)
    if multi:
        from .multi_book_collector import enter_multi_book_mode

        count = multi.get("count")
        answer = enter_multi_book_mode(session, requested_count=count)
        save_commerce_session(session)
        logger.info(
            "commerce_multi_book_mode sid=%s requested=%s expected_next=%s",
            _short_sid(sid),
            count or "unknown",
            session.expected_next,
        )
        logger.info(
            "commerce_commit_resolved sid=%s intent=multi_book_collection_start action=enter_multi_book selected=%s next=%s",
            _short_sid(sid),
            (session.selected_candidate_id or "none")[:8],
            session.expected_next,
        )
        return CommerceCommitResult(
            matched=True,
            intent="multi_book_collection_start",
            action="enter_multi_book",
            direct_answer=answer,
            expected_next="multi_isbn_or_title",
            selected_candidate_id=session.selected_candidate_id,
            quantity=count or 1,
            needs_next_book=True,
            needs_payment=False,
            reason="multi_book_start",
        )

    # Mixed product identifiers (book + newspaper + magazine in one turn)
    if not is_payment_link_phrase(normalized) and not is_add_and_next_book_phrase(normalized):
        mixed = extract_product_identifiers(normalized)
        if len(mixed) >= 2:
            from .multi_book_collector import handle_mixed_identifiers

            result = handle_mixed_identifiers(normalized, session, mixed, session_state=session_state)
            if result.matched:
                save_commerce_session(session)
                return result

    # Two ISBNs in one utterance
    isbns = extract_all_isbns(normalized)
    if len(isbns) >= 2 and not is_commerce_control_phrase(normalized):
        from .multi_book_collector import handle_multiple_isbns

        result = handle_multiple_isbns(normalized, session, isbns, session_state=session_state)
        if result.matched:
            save_commerce_session(session)
            logger.info(
                "commerce_commit_resolved sid=%s intent=%s action=%s selected=%s next=%s",
                _short_sid(sid), result.intent, result.action or "none",
                (result.selected_candidate_id or "none")[:8], result.expected_next or "none",
            )
            return result

    # Add both confirmation
    if re.search(r"\badd both\b", normalized, re.I) and len(session.last_candidates) >= 2:
        result = _add_all_candidates(session, session_state)
        save_commerce_session(session)
        logger.info(
            "commerce_commit_resolved sid=%s intent=add_both action=add_all selected=%s next=%s",
            _short_sid(sid),
            (result.selected_candidate_id or "none")[:8],
            result.expected_next or "none",
        )
        return result

    offered_add = _agent_offered_add(session, session_state)

    # Add + next book
    if is_add_and_next_book_phrase(normalized) and candidate and offered_add:
        next_msg = (
            f"I added {candidate.title} to your order. "
            "Please give me the ISBN, title, author, or subject for the next book."
        )
        expected = "isbn_number" if re.search(r"\bisbn\b", normalized, re.I) else "book_identifier"
        result = _add_selected(
            session, session_state,
            next_book_message=next_msg,
        )
        result.intent = "add_and_next_book"
        result.expected_next = expected
        result.needs_next_book = True
        save_commerce_session(session)
        logger.info(
            "commerce_commit_resolved sid=%s intent=add_and_next_book action=add_selected selected=%s next=%s",
            _short_sid(sid),
            (candidate.candidate_id or "none")[:8],
            expected,
        )
        return result

    # Strong add confirmations
    if is_strong_add_commitment(normalized) and candidate and offered_add:
        result = _add_selected(session, session_state)
        save_commerce_session(session)
        logger.info(
            "commerce_commit_resolved sid=%s intent=add_selected action=add_selected selected=%s next=%s",
            _short_sid(sid),
            (candidate.candidate_id or "none")[:8],
            result.expected_next or "none",
        )
        return result

    # Rejection
    if is_rejection_phrase(normalized) and candidate:
        session.selected_candidate_id = None
        save_commerce_session(session)
        return CommerceCommitResult(
            matched=True,
            intent="reject_candidate",
            action="reject",
            direct_answer="Okay, I won't add that one. Which book would you like instead?",
            expected_next="book_identifier",
            selected_candidate_id=None,
            quantity=0,
            needs_next_book=False,
            needs_payment=False,
            reason="rejected",
        )

    # Block commerce control phrases from falling through
    if is_commerce_control_phrase(normalized):
        if candidate and is_strong_add_commitment(normalized):
            result = _add_selected(session, session_state)
            save_commerce_session(session)
            return result
        return CommerceCommitResult(
            matched=True,
            intent="commerce_control",
            action="block_search",
            direct_answer=None,
            expected_next=session.expected_next,
            selected_candidate_id=session.selected_candidate_id,
            quantity=1,
            needs_next_book=False,
            needs_payment=False,
            reason="control_phrase_blocked",
            response_mode="pass_through",
        )

    return unresolved
