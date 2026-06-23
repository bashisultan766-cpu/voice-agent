"""Cart orchestrator — deterministic cart mutations (v4.14.6)."""
from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING, Any, Optional

from .commerce_session import (
    CommerceSession,
    add_selected_candidate_to_cart,
    cart_summary,
    get_last_selected_or_best_candidate,
    remove_cart_line,
    select_candidate,
    sync_commerce_cart_to_session_state,
)

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)


def title_safe_for_log(title: str, max_len: int = 40) -> str:
    clean = re.sub(r"[^\w\s\-',.:]+", "", (title or "").strip())
    return (clean[:max_len] + "...") if len(clean) > max_len else clean


def add_candidate_to_cart(
    session: CommerceSession,
    candidate_id: str | None = None,
    quantity: int = 1,
    session_state: Optional["SessionState"] = None,
) -> dict[str, Any]:
    if candidate_id:
        select_candidate(session, candidate_id)
    line = add_selected_candidate_to_cart(session, quantity=quantity)
    if not line:
        candidate = get_last_selected_or_best_candidate(session)
        if candidate and candidate.availability == "out_of_stock":
            return {
                "success": False,
                "message": (
                    f"That book looks out of stock right now. "
                    "I can take your email for customer service follow-up."
                ),
            }
        if candidate and not candidate.variant_id:
            return {
                "success": False,
                "message": (
                    "I found the book, but I don't have a valid checkout option for it right now."
                ),
            }
        return {
            "success": False,
            "message": "I couldn't add that book because I don't have a confirmed variant from the store.",
        }
    sync_commerce_cart_to_session_state(session, session_state)
    cart_lines = cart_summary(session)["count"]
    logger.info(
        "commerce_auto_add_selected sid=%s title_safe=%s cart_lines=%d",
        session.sid[:6],
        title_safe_for_log(line.title),
        cart_lines,
    )
    return {
        "success": True,
        "message": f"I added {line.title} to your order. Would you like to add another book?",
        "line_id": line.line_id,
        "cart_lines": cart_lines,
    }


def remove_cart_item(
    session: CommerceSession,
    title_or_line_id: str | None = None,
    session_state: Optional["SessionState"] = None,
) -> dict[str, Any]:
    line = remove_cart_line(
        session,
        line_id=title_or_line_id if title_or_line_id and len(title_or_line_id) <= 12 else None,
        title=title_or_line_id,
    )
    if line:
        sync_commerce_cart_to_session_state(session, session_state)
        return {"success": True, "message": f"I removed {line.title} from your order."}
    return {"success": False, "message": "I don't see that book in your order right now."}


def replace_cart_item(session: CommerceSession, old: str, new_candidate_id: str) -> dict[str, Any]:
    removed = remove_cart_line(session, title=old)
    if not removed:
        return {"success": False, "message": "I couldn't find that book to replace."}
    return add_candidate_to_cart(session, new_candidate_id)


def cart_count(session: CommerceSession) -> int:
    return cart_summary(session)["count"]


def cart_summary_text(session: CommerceSession) -> str:
    summary = cart_summary(session)
    count = summary["count"]
    if count == 0:
        return "Your order is empty right now."
    titles = summary["titles"]
    if count == 1:
        joined = titles[0]
    elif count == 2:
        joined = f"{titles[0]} and {titles[1]}"
    else:
        joined = ", ".join(titles[:-1]) + f", and {titles[-1]}"
    subtotal = summary.get("subtotal")
    if subtotal:
        return (
            f"You have {count} books in your order: {joined}. "
            f"Your subtotal before shipping is {subtotal}."
        )
    return f"You have {count} books in your order: {joined}."
