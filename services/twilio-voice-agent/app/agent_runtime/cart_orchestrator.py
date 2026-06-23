"""Cart orchestrator — deterministic cart mutations (v4.14.5)."""
from __future__ import annotations

import re
from typing import Any

from .commerce_session import (
    CommerceSession,
    add_selected_candidate_to_cart,
    cart_summary,
    get_last_selected_or_best_candidate,
    remove_cart_line,
    select_candidate,
)


def title_safe_for_log(title: str, max_len: int = 40) -> str:
    clean = re.sub(r"[^\w\s\-',.:]+", "", (title or "").strip())
    return (clean[:max_len] + "...") if len(clean) > max_len else clean


def add_candidate_to_cart(
    session: CommerceSession,
    candidate_id: str | None = None,
    quantity: int = 1,
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
                    f"I found {candidate.title}, but it looks out of stock right now. "
                    "I can take your email and have customer service follow up if we can get it."
                ),
            }
        return {
            "success": False,
            "message": "I couldn't add that book because I don't have a confirmed variant from the store.",
        }
    return {
        "success": True,
        "message": f"I added {line.title} to your order. Would you like to add another book?",
        "line_id": line.line_id,
    }


def remove_cart_item(session: CommerceSession, title_or_line_id: str | None = None) -> dict[str, Any]:
    line = remove_cart_line(session, line_id=title_or_line_id if title_or_line_id and len(title_or_line_id) <= 12 else None, title=title_or_line_id)
    if line:
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
