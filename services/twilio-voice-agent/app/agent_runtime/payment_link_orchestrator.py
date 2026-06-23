"""Payment link orchestrator — checkout/email state machine (v4.14.9)."""
from __future__ import annotations

import logging
import re
import uuid
from typing import TYPE_CHECKING, Any, Optional

from ..payment.safety import _mask_email, require_confirmed_cart, require_confirmed_email
from .cart_orchestrator import cart_summary_text
from .commerce_session import CommerceSession, DestinationGroup, cart_summary

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

GROUP_STATES = (
    "group_created",
    "cart_group_confirm_required",
    "email_capture_required",
    "email_spellback_required",
    "email_confirmed",
    "checkout_create_pending",
    "checkout_created",
    "email_send_pending",
    "payment_link_sent",
    "failed",
    "escalated",
)

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
_MULTI_GROUP_PAT = re.compile(
    r"(?:send|these|the)\s+(?:\d+\s+)?(?:books?|items?|newspapers?|magazines?)?\s*"
    r"(?:to|at)\s+(.+?)(?:\s+and\s+(?:the\s+)?other\s+\d+\s+(?:books?|items?)\s+(?:to|at)\s+(.+))?$",
    re.I,
)


def _short_sid(sid: str) -> str:
    return sid[:6] if sid else "?"


def _log_payment_state(sid: str, state: str) -> None:
    logger.info("payment_flow_state sid=%s state=%s", _short_sid(sid), state)


def _log_group_state(sid: str, group_id: str, state: str) -> None:
    logger.info(
        "payment_group_state sid=%s group_id=%s state=%s",
        _short_sid(sid),
        group_id[:8],
        state,
    )


def parse_spoken_email(text: str) -> str | None:
    from .email_capture_orchestrator import normalize_spoken_email

    result = normalize_spoken_email(text)
    return result.email if result.syntax_valid else None


def prepare_email_spellback(email: str, *, letter_by_letter: bool = False) -> str:
    from .email_capture_orchestrator import prepare_email_spellback as _prep

    return _prep(email, letter_by_letter=letter_by_letter)


def _cart_needs_customer_confirmation(session_state: Optional["SessionState"]) -> bool:
    if session_state is None:
        return True
    items = getattr(session_state, "cart_items", None) or []
    if not items:
        return True
    return any(str(i.get("confirmation_status", "")).lower() != "confirmed" for i in items)


def _set_group_state(group: DestinationGroup, state: str) -> None:
    group.state = state
    _log_group_state("", group.group_id, state)


def get_or_create_group(
    commerce: CommerceSession,
    *,
    group_id: str | None = None,
    name: str | None = None,
) -> DestinationGroup:
    from .commerce_session import create_or_update_destination_group

    gid = group_id or str(uuid.uuid4())[:8]
    return create_or_update_destination_group(commerce, group_id=gid, name=name)


def advance_group_state(
    group: DestinationGroup,
    *,
    commerce: CommerceSession,
    session_state: Optional["SessionState"] = None,
    cart_confirmed: bool = False,
    email_confirmed: bool = False,
) -> dict[str, Any]:
    """Advance one destination group through the payment state machine."""
    sid = commerce.sid
    active_lines = [
        ln for ln in commerce.active_cart
        if ln.line_id in group.cart_line_ids and ln.status == "active"
    ]

    if not active_lines:
        _set_group_state(group, "failed")
        return {"state": "failed", "message": "That group has no items in the order."}

    invalid = [ln for ln in active_lines if not ln.variant_id or ln.orderability_status not in (None, "orderable")]
    if invalid:
        _set_group_state(group, "failed")
        return {
            "state": "failed",
            "message": "Some items in that group aren't available for checkout right now.",
        }

    if not group.confirmed_cart and not cart_confirmed:
        _set_group_state(group, "cart_group_confirm_required")
        titles = [ln.title for ln in active_lines]
        return {
            "state": "cart_group_confirm_required",
            "message": (
                f"For this group I have {', '.join(titles[:3])}. "
                "Should I prepare a payment link for these?"
            ),
        }

    group.confirmed_cart = True

    if not group.email:
        _set_group_state(group, "email_capture_required")
        return {
            "state": "email_capture_required",
            "message": "What email should I send this payment link to?",
        }

    if not group.confirmed_email and not email_confirmed:
        if session_state and getattr(session_state, "pending_email", ""):
            _set_group_state(group, "email_spellback_required")
            return {
                "state": "email_spellback_required",
                "message": prepare_email_spellback(session_state.pending_email),
            }
        _set_group_state(group, "email_spellback_required")
        return {
            "state": "email_spellback_required",
            "message": prepare_email_spellback(group.email),
        }

    group.confirmed_email = True
    _set_group_state(group, "checkout_create_pending")
    return {
        "state": "checkout_create_pending",
        "message": None,
        "response_mode": "needs_tools",
        "tool_categories": ["payment_flow"],
        "group_id": group.group_id,
    }


def parse_multi_group_assignment(text: str, commerce: CommerceSession) -> list[dict[str, Any]] | None:
    """Parse speech assigning cart lines to multiple email destinations."""
    from .email_capture_orchestrator import normalize_spoken_email

    normalized = re.sub(r"\s+", " ", (text or "").strip())
    active = [ln for ln in commerce.active_cart if ln.status == "active"]
    if len(active) < 2:
        return None

    # Pattern: "these 2 books to X and the other 4 to Y"
    split_match = re.search(
        r"(?:send|these)\s+(?:(\d+|two|three|four|\w+)\s+)?(?:books?|items?)\s+to\s+(.+?)"
        r"\s+and\s+(?:the\s+)?other\s+(?:(\d+|two|three|four|\w+)\s+)?(?:books?|items?)\s+to\s+(.+?)\.?$",
        normalized,
        re.I,
    )
    if not split_match:
        return None

    count_map = {"two": 2, "three": 3, "four": 4, "five": 5}
    n1 = count_map.get(split_match.group(1).lower()) or int(split_match.group(1))
    n2 = count_map.get(split_match.group(3).lower()) or int(split_match.group(3))
    email1 = normalize_spoken_email(split_match.group(2)).email
    email2 = normalize_spoken_email(split_match.group(4)).email
    if not email1 or not email2:
        return None

    lines1 = [ln.line_id for ln in active[:n1]]
    lines2 = [ln.line_id for ln in active[n1:n1 + n2]]
    return [
        {"line_ids": lines1, "email": email1, "name": "group_1"},
        {"line_ids": lines2, "email": email2, "name": "group_2"},
    ]


def create_multi_payment_groups(
    commerce: CommerceSession,
    assignments: list[dict[str, Any]],
) -> list[DestinationGroup]:
    """Create destination groups from parsed assignments."""
    groups: list[DestinationGroup] = []
    for idx, assignment in enumerate(assignments):
        result = assign_lines_to_group(
            commerce,
            assignment["line_ids"],
            name=assignment.get("name") or f"group_{idx + 1}",
            email=assignment.get("email"),
        )
        group = next(g for g in commerce.destination_groups if g.group_id == result["group_id"])
        group.state = "group_created"
        groups.append(group)
    return groups


def handle_multi_group_payment(
    commerce: CommerceSession,
    *,
    session_state: Optional["SessionState"] = None,
) -> dict[str, Any]:
    """Process payment for multiple destination groups."""
    groups = [g for g in commerce.destination_groups if g.cart_line_ids]
    if len(groups) < 2:
        return handle_payment_request(commerce, session_state=session_state)

    results: list[dict[str, Any]] = []
    succeeded = 0
    failed = 0
    for group in groups:
        advance = advance_group_state(
            group,
            commerce=commerce,
            session_state=session_state,
        )
        results.append({"group_id": group.group_id, **advance})
        if advance.get("state") == "checkout_create_pending":
            succeeded += 1
        elif advance.get("state") == "failed":
            failed += 1

    if succeeded and failed:
        return {
            "response_mode": "direct_answer",
            "message": (
                "I sent the first payment link, but I had trouble with the second one. "
                "I can try again or send it to customer service."
            ),
            "expected_next": "payment_retry",
            "tool_categories": [],
            "groups": results,
        }

    pending_email = [r for r in results if r.get("state") == "email_capture_required"]
    if pending_email:
        return {
            "response_mode": "direct_answer",
            "message": pending_email[0].get("message"),
            "expected_next": "email_capture",
            "tool_categories": [],
            "groups": results,
        }

    spellback = [r for r in results if r.get("state") == "email_spellback_required"]
    if spellback:
        return {
            "response_mode": "direct_answer",
            "message": spellback[0].get("message"),
            "expected_next": "email_confirm",
            "tool_categories": [],
            "groups": results,
        }

    return {
        "response_mode": "needs_tools",
        "message": None,
        "expected_next": "checkout_create",
        "tool_categories": ["payment_flow"],
        "groups": results,
    }


def mark_group_checkout_result(
    group: DestinationGroup,
    *,
    success: bool,
    checkout_id: str = "",
) -> None:
    if success:
        group.checkout_status = "created"
        group.state = "checkout_created"
        logger.info("payment_link_created sid=? group_id=%s checkout_id=%s url_masked=True", group.group_id[:8], checkout_id[:8] if checkout_id else "")
    else:
        group.checkout_status = "failed"
        group.state = "failed"


def mark_group_email_sent(group: DestinationGroup, *, success: bool, email: str = "") -> None:
    masked = _mask_email(email)
    if success:
        group.payment_link_status = "sent"
        group.state = "payment_link_sent"
        logger.info("payment_link_email_sent sid=? group_id=%s masked_email=%s", group.group_id[:8], masked)
    else:
        group.payment_link_status = "failed"
        group.state = "failed"
        logger.info("payment_link_email_failed sid=? group_id=%s masked_email=%s", group.group_id[:8], masked)


def payment_blocked_message(checkout_ok: bool, email_ok: bool) -> str:
    if not checkout_ok:
        return "I couldn't create the payment link right now. I can try again or connect you with customer service."
    if not email_ok:
        return "I need to confirm the email before I send the payment link."
    return "I couldn't send the payment link. I can try again or connect you with customer service."


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

    # Multi-group path
    groups = [g for g in commerce.destination_groups if g.cart_line_ids]
    if len(groups) >= 2:
        return handle_multi_group_payment(commerce, session_state=session_state)

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

    invalid_variant = any(
        not ln.variant_id or ln.orderability_status not in (None, "orderable")
        for ln in summary["lines"]
    )
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
            label = "items" if len({ln.product_kind for ln in summary["lines"]}) > 1 else "books"
            return {
                "response_mode": "direct_answer",
                "message": (
                    f"I have {summary['count']} {label} in your order: "
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
                "message": cart_summary_text(commerce) + " Should I send the payment link for these?",
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


def payment_success_message(email: str, checkout_id: str = "", *, checkout_ok: bool = True, email_ok: bool = True) -> str:
    if not checkout_ok or not email_ok:
        return payment_blocked_message(checkout_ok, email_ok)
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
    group.state = "group_created"
    for line in commerce.active_cart:
        if line.line_id in line_ids:
            line.destination_group_id = group.group_id
    titles = [ln.title for ln in commerce.active_cart if ln.line_id in line_ids and ln.status == "active"]
    return {
        "group_id": group.group_id,
        "titles": titles,
        "message": f"Got it. I'll keep those as a separate payment link for {', '.join(titles[:3])}.",
    }


def format_partial_multi_group_message(
    groups: list[DestinationGroup],
    *,
    succeeded_ids: list[str],
    failed_ids: list[str],
) -> str:
    def _masked(g: DestinationGroup) -> str:
        return _mask_email(g.email or "") if g.email else "your email"

    if succeeded_ids and failed_ids:
        ok_g = next((g for g in groups if g.group_id in succeeded_ids), None)
        fail_g = next((g for g in groups if g.group_id in failed_ids), None)
        ok_email = _masked(ok_g) if ok_g else "your email"
        fail_email = _masked(fail_g) if fail_g else "your email"
        return (
            f"I sent the first payment link to {ok_email}, but I had trouble sending the second one "
            f"to {fail_email}. I can try again or send it to customer service."
        )
    return (
        "I sent the first payment link, but I had trouble with the second one. "
        "I can try again or send it to customer service."
    )


def group_cart_items(commerce: CommerceSession, group: DestinationGroup) -> list[dict]:
    items: list[dict] = []
    for line in commerce.active_cart:
        if line.line_id in group.cart_line_ids and line.status == "active":
            items.append({
                "title": line.title,
                "variant_id": line.variant_id,
                "product_id": line.product_id,
                "quantity": line.quantity,
                "price": line.price or "",
                "confirmation_status": "confirmed",
            })
    return items


def assign_group_idempotency(
    commerce: CommerceSession,
    group: DestinationGroup,
    *,
    confirmed_email: str = "",
) -> str:
    from ..payment.payment_idempotency import compute_idempotency_key

    items = group_cart_items(commerce, group)
    email = confirmed_email or group.email or ""
    key = compute_idempotency_key(
        call_sid=commerce.sid,
        group_id=group.group_id,
        items=items,
        confirmed_email=email,
    )
    group.idempotency_key = key
    return key


async def certify_group_payment(
    commerce: CommerceSession,
    group: DestinationGroup,
    session_state: Optional["SessionState"],
) -> dict[str, Any]:
    """Run checkout + email certification for one destination group."""
    from ..payment.checkout_certifier import certify_checkout
    from ..payment.email_certifier import payment_sent_safe_message, send_payment_email_certified
    from ..payment.payment_idempotency import check_idempotency

    email = group.email or (getattr(session_state, "confirmed_email", "") if session_state else "")
    if not group.confirmed_email and session_state and getattr(session_state, "confirmed_email", ""):
        group.confirmed_email = True
        group.email = group.email or session_state.confirmed_email

    key = assign_group_idempotency(commerce, group, confirmed_email=email or "")
    idem = check_idempotency(key)
    if not idem.allowed:
        group.failure_reason = "duplicate_request"
        group.checkout_status = "failed"
        group.state = "failed"
        return {"success": False, "message": idem.message, "group_id": group.group_id}

    items = group_cart_items(commerce, group)
    if session_state is None:
        from ..state.models import SessionState
        session_state = SessionState(
            session_id="cert",
            call_sid=commerce.sid,
            from_number="",
            to_number="",
        )
    session_state.confirmed_email = email or session_state.confirmed_email or ""
    session_state.cart_items = items

    checkout = await certify_checkout(
        session_state,
        items,
        group_id=group.group_id,
        confirmed_email=email or "",
    )
    group.idempotency_key = checkout.idempotency_key or key

    if not checkout.success:
        group.failure_reason = checkout.failure_class
        group.checkout_status = "failed"
        group.state = "failed"
        return {
            "success": False,
            "message": checkout.safe_message,
            "group_id": group.group_id,
            "checkout_ok": False,
        }

    group.checkout_status = "created"
    group.state = "checkout_created"
    titles = [i.get("title", "") for i in items if i.get("title")]
    summary = ", ".join(titles[:3])

    email_result = await send_payment_email_certified(
        email or session_state.confirmed_email,
        checkout.checkout_url,
        summary,
        group_id=group.group_id,
        idempotency_key=group.idempotency_key or key,
        confirmed=bool(group.confirmed_email or session_state.confirmed_email),
    )

    if email_result.success:
        group.payment_link_status = "sent"
        group.email_status = "sent"
        group.resend_message_id = email_result.message_id
        group.state = "payment_link_sent"
        return {
            "success": True,
            "message": email_result.safe_message,
            "group_id": group.group_id,
            "checkout_ok": True,
            "email_ok": True,
        }

    group.failure_reason = email_result.failure_class
    group.payment_link_status = "failed"
    group.email_status = "failed"
    group.state = "failed"
    return {
        "success": False,
        "message": payment_sent_safe_message(True, email_result),
        "group_id": group.group_id,
        "checkout_ok": True,
        "email_ok": False,
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
        email_hint = _mask_email(g.email) if g.email else "your email"
        parts.append(f"one for {label} ({', '.join(titles[:2])}) to {email_hint}")
    return f"Got it. I'll keep those as two separate payment links: {' and '.join(parts)}."

