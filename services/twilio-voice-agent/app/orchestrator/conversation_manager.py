"""Conversation manager — session context and safe memory summaries."""
from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..state.models import SessionState

from .types import OrchestratorTurnContext


def new_turn_id() -> str:
    return uuid.uuid4().hex[:12]


def build_memory_summary(session: "SessionState") -> str:
    """PII-safe snapshot for supervisor/planner/composer."""
    parts: list[str] = []
    try:
        from ..cart.session import get_ledger

        cart_count = get_ledger(session).confirmed_count()
    except Exception:  # noqa: BLE001
        cart_count = len(getattr(session, "cart_items", None) or [])

    if cart_count:
        parts.append(f"cart_books={cart_count}")
    if getattr(session, "payment_cart_confirmed", False):
        parts.append("cart_confirmed=yes")
    pfs = getattr(session, "payment_flow_status", "") or "idle"
    if pfs != "idle":
        parts.append(f"payment_flow={pfs}")
    if getattr(session, "payment_email_confirmed", False):
        parts.append("email_confirmed=yes")
    elif getattr(session, "awaiting_payment_email_confirmation", False):
        parts.append("awaiting_email_confirmation=yes")
    if getattr(session, "last_selected_title", ""):
        parts.append(f"last_book={session.last_selected_title[:40]}")
    if getattr(session, "last_facility_name", ""):
        parts.append(f"facility={session.last_facility_name[:30]}")
    return "; ".join(parts) if parts else "new_call"


def begin_turn(
    session: "SessionState",
    user_text: str,
    *,
    turn_mode: str = "",
) -> OrchestratorTurnContext:
    from ..memory.memory_manager import MemoryManager

    memory = MemoryManager.load(session)
    return OrchestratorTurnContext(
        user_text=user_text,
        turn_id=new_turn_id(),
        turn_mode=turn_mode,
        memory_summary=memory.safe_summary,
    )


def record_turn(
    session: "SessionState",
    user_text: str,
    assistant_text: str,
) -> None:
    """Deprecated — use MemoryManager.record_turn."""
    from ..memory.memory_manager import MemoryManager

    MemoryManager.record_turn(session, user_text, assistant_text, source="orchestrator")
