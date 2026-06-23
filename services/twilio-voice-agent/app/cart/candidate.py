"""Immediate product candidate persistence (v4.5).

Saves ISBN/search results to session before ResponsePlanWorker or composer.
Survives caller interruption.
"""
from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING, Any, Optional

from .ledger import CartItem, CartLedger
from .session import get_ledger, sync_ledger_to_session
from .candidate_guard import should_save_candidate, log_candidate_guard

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_TITLE_SAFE = re.compile(r"[^\w\s\-',.:]+")


def title_safe_for_log(title: str, max_len: int = 40) -> str:
    clean = _TITLE_SAFE.sub("", (title or "").strip())
    return (clean[:max_len] + "...") if len(clean) > max_len else clean


def save_product_candidate(
    session: "SessionState",
    *,
    title: str,
    isbn: str = "",
    product_id: str = "",
    variant_id: str = "",
    price: str | None = None,
    available: bool = True,
    quantity: int = 1,
    source: str = "isbn_search",
    source_intent: str = "",
    source_query: str = "",
    skip_guard: bool = False,
    action_gate_approved: bool = True,
) -> Optional[CartItem]:
    """Persist a book candidate immediately after product lookup."""
    intent = source_intent or ("isbn_search" if isbn else source)
    query = source_query or (isbn or title)
    allowed, _reason = should_save_candidate(
        intent,
        query,
        is_isbn=bool(isbn),
        action_gate_approved=action_gate_approved,
        variant_id=variant_id,
    )
    if not skip_guard and not allowed:
        log_candidate_guard(False, intent, query, session.call_sid)
        return None
    log_candidate_guard(True, intent, query, session.call_sid)

    ledger = get_ledger(session)
    if isbn:
        ledger.record_isbn_provided(isbn)

    item = CartItem(
        title=title,
        isbn=isbn,
        product_id=product_id,
        variant_id=variant_id,
        quantity=max(1, quantity),
        price=price,
        available=available,
        source=source,
        confirmation_status="candidate",
        source_intent=intent,
        source_query=query,
        candidate_guard_allowed=True,
        eligible_for_checkout=False,
        selection_origin="isbn_confirmed" if isbn else "",
    )
    ledger.add_candidate(item)
    sync_ledger_to_session(session, ledger)

    session.last_product_title = title
    session.last_product_variant_id = variant_id
    session.last_product_id = product_id
    session.last_selected_title = title
    session.last_selected_product = {
        "title": title,
        "isbn": isbn,
        "product_id": product_id,
        "variant_id": variant_id,
        "price": price,
        "available": available,
        "source": source,
    }
    session.last_product_candidate = session.last_selected_product

    if isbn and isbn not in session.requested_books:
        session.requested_books.append(isbn)
    elif title and title not in session.requested_books and not isbn:
        session.requested_books.append(title)

    from ..dialogue.manager import DialogueManager
    from ..dialogue.states import DialogueState

    state = DialogueManager.get_state(session)
    state.last_product_candidate = dict(session.last_selected_product)
    state.active_flow = "cart_building"
    DialogueManager.set_state(session, state)

    logger.info(
        "product_candidate_saved isbn=%s title_safe=%s variant_present=%s sid=%s",
        isbn or "-",
        title_safe_for_log(title),
        bool(variant_id),
        session.call_sid[:6],
    )
    return item


def save_product_not_found(session: "SessionState", isbn: str) -> None:
    """Record ISBN lookup miss in ledger and session."""
    ledger = get_ledger(session)
    ledger.record_isbn_not_found(isbn)
    sync_ledger_to_session(session, ledger)
    logger.info(
        "product_candidate_not_found isbn=%s sid=%s",
        isbn,
        session.call_sid[:6],
    )


def extract_variant_from_shopify_result(top: dict) -> tuple[str, str]:
    """Return (product_id, variant_id) from a Shopify search result dict."""
    product_id = str(top.get("id") or top.get("product_id") or "")
    variant_id = str(top.get("variant_id") or "")
    if not variant_id:
        variants = top.get("variants") or []
        if variants and isinstance(variants[0], dict):
            variant_id = str(variants[0].get("id") or "")
    return product_id, variant_id


def persist_worker_product_result(
    session: "SessionState",
    data: dict[str, Any],
    *,
    isbn: str = "",
    source: str = "isbn_search",
    source_intent: str = "",
    source_query: str = "",
    action_gate_approved: bool = True,
) -> Optional[CartItem]:
    """Save candidate from a product worker result dict, or record not-found."""
    if not action_gate_approved:
        log_candidate_guard(
            False,
            source_intent or source,
            source_query or isbn,
            session.call_sid,
        )
        return None
    if not data:
        return None
    if data.get("results") == []:
        if isbn:
            save_product_not_found(session, isbn)
        return None
    title = data.get("title") or ""
    if not title and data.get("results"):
        first = data["results"][0]
        if isinstance(first, dict):
            title = first.get("title", "")
    if not title:
        return None
    product_id, variant_id = extract_variant_from_shopify_result(data)
    return save_product_candidate(
        session,
        title=title,
        isbn=data.get("isbn") or isbn,
        product_id=product_id,
        variant_id=variant_id,
        price=str(data.get("price")) if data.get("price") else None,
        available=bool(data.get("available", True)),
        source=source,
        source_intent=source_intent or source,
        source_query=source_query or data.get("query", "") or isbn or title,
        action_gate_approved=action_gate_approved,
    )
