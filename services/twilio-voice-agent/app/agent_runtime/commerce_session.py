"""CommerceSession — per-call commerce state (v4.14.5)."""
from __future__ import annotations

import logging
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any, Optional

logger = logging.getLogger(__name__)

_SESSIONS: dict[str, "CommerceSession"] = {}


@dataclass
class ProductCandidate:
    candidate_id: str
    product_id: str | None
    variant_id: str | None
    title: str
    author: str | None
    isbn: str | None
    price: str | None
    currency: str | None
    availability: str | None
    inventory_quantity: int | None
    source: str
    confidence: float
    raw_fact_ids: list[str] = field(default_factory=list)
    product_kind: str | None = None
    product_type: str | None = None
    vendor: str | None = None
    handle: str | None = None
    tags: list[str] = field(default_factory=list)
    delivery_frequency: str | None = None
    subscription_term: str | None = None
    inventory_policy: str | None = None
    status: str | None = None
    published: bool | None = None
    online_store_visible: bool | None = None
    can_add_to_cart: bool = True
    unavailable_reason: str | None = None
    checkout_variant_valid: bool = True


@dataclass
class CartLine:
    line_id: str
    product_id: str
    variant_id: str
    title: str
    isbn: str | None
    price: str | None
    quantity: int
    destination_group_id: str | None
    status: str  # active | removed | unavailable
    product_kind: str | None = None
    source_identifier: str | None = None
    orderability_status: str | None = None  # orderable | out_of_stock | draft | blocked


@dataclass
class DestinationGroup:
    group_id: str
    name: str | None
    email: str | None
    address: str | None
    facility_name: str | None
    inmate_name: str | None
    confirmed_email: bool
    confirmed_destination: bool
    cart_line_ids: list[str] = field(default_factory=list)
    confirmed_cart: bool = False
    checkout_status: str = "pending"  # pending | created | failed
    payment_link_status: str = "pending"  # pending | sent | failed | escalated
    email_status: str = "pending"  # pending | spellback | confirmed | sent | failed
    state: str = "group_created"
    idempotency_key: str | None = None
    failure_reason: str | None = None
    resend_message_id: str | None = None


@dataclass
class CommerceSession:
    sid: str
    last_candidates: list[ProductCandidate] = field(default_factory=list)
    selected_candidate_id: str | None = None
    active_cart: list[CartLine] = field(default_factory=list)
    destination_groups: list[DestinationGroup] = field(default_factory=list)
    expected_next: str | None = None
    pending_payment_group_id: str | None = None
    last_tool_answer: str | None = None
    last_product_answer: str | None = None
    last_order_answer: str | None = None
    last_refund_answer: str | None = None
    multi_book_mode: bool = False
    requested_cart_count: int | None = None
    collected_identifiers: list = field(default_factory=list)
    pending_identifier_buffer: str = ""
    current_identifier_type: str | None = None
    current_identifier_digits: str = ""


def _short_sid(sid: str) -> str:
    return sid[:6] if sid else "?"


def _title_safe(title: str, max_len: int = 40) -> str:
    import re

    clean = re.sub(r"[^\w\s\-',.:]+", "", (title or "").strip())
    return (clean[:max_len] + "...") if len(clean) > max_len else clean


def get_commerce_session(sid: str) -> CommerceSession:
    if sid not in _SESSIONS:
        _SESSIONS[sid] = CommerceSession(sid=sid)
    session = _SESSIONS[sid]
    logger.info("commerce_session_loaded sid=%s candidates=%d cart=%d", _short_sid(sid), len(session.last_candidates), len(session.active_cart))
    return session


def save_commerce_session(session: CommerceSession) -> None:
    _SESSIONS[session.sid] = session


def clear_commerce_session(sid: str) -> None:
    _SESSIONS.pop(sid, None)


def _candidate_by_id(session: CommerceSession, candidate_id: str) -> ProductCandidate | None:
    for c in session.last_candidates:
        if c.candidate_id == candidate_id:
            return c
    return None


def get_last_selected_or_best_candidate(session: CommerceSession) -> ProductCandidate | None:
    if session.selected_candidate_id:
        found = _candidate_by_id(session, session.selected_candidate_id)
        if found:
            return found
    if session.last_candidates:
        return session.last_candidates[0]
    return None


def update_candidates_from_facts(
    session: CommerceSession,
    candidates: list[ProductCandidate],
    *,
    auto_select_isbn: bool = True,
) -> None:
    session.last_candidates = list(candidates)
    selected = session.selected_candidate_id
    if auto_select_isbn:
        for c in candidates:
            if c.confidence >= 0.95 and c.isbn:
                session.selected_candidate_id = c.candidate_id
                selected = c.candidate_id
                break
    if not session.selected_candidate_id and candidates:
        session.selected_candidate_id = candidates[0].candidate_id
        selected = candidates[0].candidate_id
    logger.info(
        "commerce_candidates_updated sid=%s count=%d selected=%s",
        _short_sid(session.sid),
        len(candidates),
        selected or "none",
    )
    save_commerce_session(session)


def select_candidate(session: CommerceSession, candidate_id: str) -> ProductCandidate | None:
    candidate = _candidate_by_id(session, candidate_id)
    if candidate:
        session.selected_candidate_id = candidate_id
        logger.info("commerce_candidate_selected sid=%s candidate_id=%s", _short_sid(session.sid), candidate_id[:8])
        save_commerce_session(session)
    return candidate


def add_selected_candidate_to_cart(
    session: CommerceSession,
    quantity: int = 1,
) -> CartLine | None:
    candidate = get_last_selected_or_best_candidate(session)
    if not candidate or not candidate.variant_id or not candidate.product_id:
        return None
    if candidate.can_add_to_cart is False:
        return None
    if candidate.status and candidate.status.upper() in ("DRAFT", "ARCHIVED"):
        return None
    if candidate.availability in ("out_of_stock", "not_available_for_checkout"):
        return None
    orderability = "orderable"
    if candidate.availability == "out_of_stock":
        orderability = "out_of_stock"
    elif candidate.status and candidate.status.upper() in ("DRAFT", "ARCHIVED"):
        orderability = "draft"
    elif candidate.can_add_to_cart is False:
        orderability = "blocked"
    line = CartLine(
        line_id=str(uuid.uuid4())[:8],
        product_id=candidate.product_id,
        variant_id=candidate.variant_id,
        title=candidate.title,
        isbn=candidate.isbn,
        price=candidate.price,
        quantity=max(1, quantity),
        destination_group_id=None,
        status="active",
        product_kind=candidate.product_kind,
        source_identifier=candidate.isbn or candidate.handle or candidate.title,
        orderability_status=orderability,
    )
    session.active_cart.append(line)

    active_count = sum(1 for ln in session.active_cart if ln.status == "active")
    logger.info(
        "commerce_cart_line_added sid=%s line_id=%s title_safe=%s cart_lines=%d",
        _short_sid(session.sid),
        line.line_id,
        _title_safe(candidate.title),
        active_count,
    )
    save_commerce_session(session)
    return line


def remove_cart_line(session: CommerceSession, line_id: str | None = None, title: str | None = None) -> CartLine | None:
    active = [ln for ln in session.active_cart if ln.status == "active"]
    target: CartLine | None = None
    if line_id:
        for ln in active:
            if ln.line_id == line_id:
                target = ln
                break
    elif title:
        lowered = title.lower()
        for ln in reversed(active):
            if ln.title.lower() == lowered or lowered in ln.title.lower():
                target = ln
                break
    elif active:
        target = active[-1]
    if target:
        target.status = "removed"

        logger.info(
            "commerce_cart_line_removed sid=%s title_safe=%s",
            _short_sid(session.sid),
            _title_safe(target.title),
        )
        save_commerce_session(session)
    return target


def cart_summary(session: CommerceSession) -> dict[str, Any]:
    active = [ln for ln in session.active_cart if ln.status == "active"]
    titles = [ln.title for ln in active]
    prices = [ln.price for ln in active if ln.price]
    subtotal: str | None = None
    if prices and len(prices) == len(active):
        try:
            total = sum(float(p.replace("$", "").replace(",", "").strip()) for p in prices)
            subtotal = f"${total:.2f}"
        except (ValueError, TypeError):
            subtotal = None
    summary = {
        "count": len(active),
        "titles": titles,
        "subtotal": subtotal,
        "lines": active,
    }
    logger.info("commerce_cart_summary sid=%s lines=%d", _short_sid(session.sid), len(active))
    return summary


def create_or_update_destination_group(
    session: CommerceSession,
    *,
    group_id: str | None = None,
    name: str | None = None,
    email: str | None = None,
    address: str | None = None,
    facility_name: str | None = None,
    inmate_name: str | None = None,
    confirmed_email: bool = False,
    confirmed_destination: bool = False,
    cart_line_ids: list[str] | None = None,
) -> DestinationGroup:
    gid = group_id or str(uuid.uuid4())[:8]
    existing = next((g for g in session.destination_groups if g.group_id == gid), None)
    if existing:
        if name is not None:
            existing.name = name
        if email is not None:
            existing.email = email
        if address is not None:
            existing.address = address
        if facility_name is not None:
            existing.facility_name = facility_name
        if inmate_name is not None:
            existing.inmate_name = inmate_name
        if confirmed_email:
            existing.confirmed_email = True
        if confirmed_destination:
            existing.confirmed_destination = True
        if cart_line_ids:
            existing.cart_line_ids = list(cart_line_ids)
        group = existing
    else:
        group = DestinationGroup(
            group_id=gid,
            name=name,
            email=email,
            address=address,
            facility_name=facility_name,
            inmate_name=inmate_name,
            confirmed_email=confirmed_email,
            confirmed_destination=confirmed_destination,
            cart_line_ids=list(cart_line_ids or []),
        )
        session.destination_groups.append(group)
    logger.info("commerce_destination_group_updated sid=%s group_id=%s", _short_sid(session.sid), gid[:8])
    save_commerce_session(session)
    return group


def sync_commerce_to_session_state(commerce: CommerceSession, session_state) -> None:
    """Mirror selected candidate and active cart into SessionState for legacy workers."""
    candidate = get_last_selected_or_best_candidate(commerce)
    if candidate and session_state is not None:
        session_state.last_product_candidate = {
            "candidate_id": candidate.candidate_id,
            "title": candidate.title,
            "isbn": candidate.isbn or "",
            "product_id": candidate.product_id or "",
            "variant_id": candidate.variant_id or "",
            "price": candidate.price or "",
            "available": candidate.availability != "out_of_stock",
            "author": candidate.author or "",
        }
        session_state.last_selected_product = dict(session_state.last_product_candidate)
    sync_commerce_cart_to_session_state(commerce, session_state)


def sync_commerce_cart_to_session_state(commerce: CommerceSession, session_state) -> None:
    """Mirror CommerceSession active cart lines into SessionState cart_items."""
    if session_state is None:
        return
    active = [ln for ln in commerce.active_cart if ln.status == "active"]
    if not active:
        return
    session_state.cart_items = [
        {
            "title": ln.title,
            "variant_id": ln.variant_id,
            "product_id": ln.product_id,
            "quantity": ln.quantity,
            "confirmation_status": "confirmed",
            "isbn": ln.isbn or "",
            "price": ln.price or "",
        }
        for ln in active
    ]


def commerce_session_to_dict(session: CommerceSession) -> dict:
    return asdict(session)
