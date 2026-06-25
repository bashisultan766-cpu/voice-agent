"""
Per-email payment groups for the live CartLedger path (v4.27).

Supports multiple emails in one call, e.g.:
  "send 2 books to bashi at gmail dot com and the other 3 to orders at company dot com"
"""
from __future__ import annotations

import logging
import re
import uuid
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_COUNT_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10,
}

_MULTI_ASSIGN_PAT = re.compile(
    r"(?:send\s+)?"
    r"(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?"
    r"(?:books?|items?|copies?)\s+(?:to|at|on)\s+(.+?)"
    r"\s+and\s+"
    r"(?:(?:the\s+)?other\s+)?"
    r"(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?"
    r"(?:(?:books?|items?|copies?)\s+)?"
    r"(?:to|at|on)\s+(.+?)\s*$",
    re.I,
)


def _parse_count(token: str | None, remaining: int) -> int:
    if not token:
        return remaining
    t = token.strip().lower()
    if t in _COUNT_WORDS:
        return _COUNT_WORDS[t]
    if t.isdigit():
        return max(1, int(t))
    return remaining


def _extract_email_fragment(fragment: str) -> str | None:
    from ..payment.payment_state_machine import extract_email_from_text

    return extract_email_from_text(fragment)


def _ledger_confirmed(session: "SessionState") -> list[dict[str, Any]]:
    from ..cart.session import get_ledger

    ledger = get_ledger(session)
    return [
        {
            "variant_id": i.variant_id,
            "title": i.title,
            "quantity": i.quantity,
            "price": i.price,
        }
        for i in ledger.confirmed_items
        if i.variant_id
    ]


def _group_dict(
    *,
    variant_ids: list[str],
    titles: list[str],
    group_id: str | None = None,
) -> dict[str, Any]:
    return {
        "group_id": group_id or str(uuid.uuid4())[:8],
        "variant_ids": variant_ids,
        "titles": titles,
        "pending_email": "",
        "confirmed_email": "",
        "email_confirmed": False,
        "awaiting_email_confirmation": False,
        "checkout_url": "",
        "payment_link_sent": False,
    }


def init_single_group_from_cart(session: "SessionState") -> dict[str, Any]:
    """One group containing all confirmed cart lines (default path)."""
    items = _ledger_confirmed(session)
    group = _group_dict(
        variant_ids=[i["variant_id"] for i in items],
        titles=[i["title"] for i in items if i.get("title")],
    )
    session.payment_destination_groups = [group]
    session.active_payment_group_index = 0
    session.multi_email_payment_active = False
    return group


def ensure_payment_groups(session: "SessionState") -> list[dict[str, Any]]:
    groups = list(getattr(session, "payment_destination_groups", None) or [])
    if not groups:
        init_single_group_from_cart(session)
        return list(session.payment_destination_groups)
    return groups


def try_parse_multi_email_assignment(
    text: str,
    session: "SessionState",
) -> list[dict[str, Any]] | None:
    """
    Parse split-payment speech into destination groups.

    Example: "send 2 books to a at gmail dot com and the other 3 to b at yahoo dot com"
    """
    items = _ledger_confirmed(session)
    if len(items) < 2:
        return None

    normalized = re.sub(r"\s+", " ", (text or "").strip())
    match = _MULTI_ASSIGN_PAT.search(normalized)
    if not match:
        return None

    n1 = _parse_count(match.group(1), len(items))
    email1 = _extract_email_fragment(match.group(2) or "")
    n2 = _parse_count(match.group(3), max(0, len(items) - n1))
    email2 = _extract_email_fragment(match.group(4) or "")
    if not email1 or not email2:
        return None
    if n1 + n2 > len(items):
        n2 = max(0, len(items) - n1)
    if n1 < 1 or n2 < 1:
        return None

    chunk1, chunk2 = items[:n1], items[n1:n1 + n2]
    groups = [
        _group_dict(
            variant_ids=[i["variant_id"] for i in chunk1],
            titles=[i["title"] for i in chunk1 if i.get("title")],
        ),
        _group_dict(
            variant_ids=[i["variant_id"] for i in chunk2],
            titles=[i["title"] for i in chunk2 if i.get("title")],
        ),
    ]
    groups[0]["pending_email"] = email1
    groups[1]["pending_email"] = email2
    session.payment_destination_groups = groups
    session.active_payment_group_index = 0
    session.multi_email_payment_active = True
    logger.info(
        "payment_multi_group_parsed sid=%s group_count=%d",
        (session.call_sid or "")[:6],
        len(groups),
    )
    return groups


def get_active_group(session: "SessionState") -> dict[str, Any] | None:
    groups = ensure_payment_groups(session)
    idx = int(getattr(session, "active_payment_group_index", 0) or 0)
    if 0 <= idx < len(groups):
        return groups[idx]
    return None


def active_group_index(session: "SessionState") -> int:
    return int(getattr(session, "active_payment_group_index", 0) or 0)


def pending_groups_remain(session: "SessionState") -> bool:
    groups = ensure_payment_groups(session)
    return any(not g.get("payment_link_sent") for g in groups)


def sync_active_group_to_session_email(session: "SessionState") -> None:
    """Load active group's email fields into session canonical email state."""
    group = get_active_group(session)
    if not group:
        return
    pending = (group.get("pending_email") or "").strip().lower()
    confirmed = (group.get("confirmed_email") or "").strip().lower()
    if pending and not group.get("email_confirmed"):
        session.pending_payment_email = pending
        session.pending_email = pending
        session.last_offered_payment_email = pending
        session.confirmed_email = ""
        session.payment_email_confirmed = False
        session.awaiting_payment_email_confirmation = bool(
            group.get("awaiting_email_confirmation")
        )
    elif group.get("email_confirmed") and confirmed:
        session.confirmed_email = confirmed
        session.payment_email_confirmed = True
        session.awaiting_payment_email_confirmation = False
        session.pending_payment_email = ""
        session.pending_email = ""


def save_session_email_to_active_group(session: "SessionState") -> None:
    """Persist session email state back to the active payment group."""
    groups = list(getattr(session, "payment_destination_groups", None) or [])
    idx = active_group_index(session)
    if not groups or idx >= len(groups):
        return
    g = groups[idx]
    pending = (
        (getattr(session, "pending_payment_email", "") or "")
        or (getattr(session, "pending_email", "") or "")
    ).strip().lower()
    confirmed = (getattr(session, "confirmed_email", "") or "").strip().lower()
    if pending:
        g["pending_email"] = pending
        g["awaiting_email_confirmation"] = bool(
            getattr(session, "awaiting_payment_email_confirmation", False)
        )
    if confirmed and getattr(session, "payment_email_confirmed", False):
        g["confirmed_email"] = confirmed
        g["email_confirmed"] = True
        g["awaiting_email_confirmation"] = False
    session.payment_destination_groups = groups


def group_checkout_items(session: "SessionState", group: dict[str, Any] | None = None) -> list[dict]:
    group = group or get_active_group(session)
    if not group:
        from ..cart.session import get_ledger
        return get_ledger(session).to_checkout_items()
    wanted = set(group.get("variant_ids") or [])
    from ..cart.session import get_ledger

    return [
        {
            "variant_id": i.variant_id,
            "quantity": i.quantity,
            "title": i.title,
            "price": i.price,
        }
        for i in get_ledger(session).confirmed_items
        if i.variant_id in wanted
    ]


def group_titles_phrase(group: dict[str, Any]) -> str:
    titles = [t for t in (group.get("titles") or []) if t]
    if not titles:
        return "your books"
    if len(titles) == 1:
        return titles[0]
    if len(titles) == 2:
        return f"{titles[0]} and {titles[1]}"
    return ", ".join(titles[:-1]) + f", and {titles[-1]}"


def mark_active_group_sent(session: "SessionState", *, checkout_url: str = "") -> None:
    groups = list(getattr(session, "payment_destination_groups", None) or [])
    idx = active_group_index(session)
    if idx >= len(groups):
        return
    g = groups[idx]
    g["payment_link_sent"] = True
    g["email_confirmed"] = True
    if checkout_url:
        g["checkout_url"] = checkout_url
    session.payment_destination_groups = groups


def advance_to_next_payment_group(session: "SessionState") -> dict[str, Any] | None:
    """Move to next unsent group; reset email state for capture."""
    groups = list(getattr(session, "payment_destination_groups", None) or [])
    for idx, g in enumerate(groups):
        if g.get("payment_link_sent"):
            continue
        session.active_payment_group_index = idx
        session.confirmed_email = ""
        session.payment_email_confirmed = False
        session.pending_payment_email = (g.get("pending_email") or "").strip().lower()
        session.pending_email = session.pending_payment_email
        session.last_offered_payment_email = session.pending_payment_email
        session.awaiting_payment_email_confirmation = bool(session.pending_payment_email)
        session.awaiting_payment_email = not session.pending_payment_email
        session.checkout_url = ""
        session.pending_checkout_url = ""
        session.payment_flow_status = (
            "awaiting_email_confirmation"
            if session.pending_payment_email
            else "awaiting_email"
        )
        logger.info(
            "payment_group_advanced sid=%s group_index=%d group_id=%s",
            (session.call_sid or "")[:6],
            idx,
            (g.get("group_id") or "")[:8],
        )
        return g
    return None


def next_group_engagement_prompt(session: "SessionState") -> str | None:
    """After advancing, describe the active (unsent) group needing an email."""
    groups = ensure_payment_groups(session)
    if len(groups) < 2:
        return None
    group = get_active_group(session)
    if not group or group.get("payment_link_sent"):
        return None
    titles = group_titles_phrase(group)
    count = len(group.get("variant_ids") or [])
    book_word = "book" if count == 1 else "books"
    return (
        f"While I prepare that link, let's set up the next one. "
        f"I still need an email for {count} {book_word}: {titles}. "
        f"What email should I send that payment link to?"
    )


def send_summary_for_active_group(session: "SessionState") -> str:
    """Tell caller which books go to the current email."""
    group = get_active_group(session)
    if not group:
        return ""
    from ..pipeline.email_speller import speak_email

    titles = group_titles_phrase(group)
    email = (
        (getattr(session, "confirmed_email", "") or "")
        or (group.get("confirmed_email") or "")
        or (group.get("pending_email") or "")
    )
    spoken_email = speak_email(email) if email else "your email"
    return f"I'm sending {titles} to {spoken_email}."
