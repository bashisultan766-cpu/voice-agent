"""
Unified MemoryManager — live call state, summaries, structured facts, resume.

Redis remains the active store. When DATABASE_URL is set, optional Postgres
persistence hooks are invoked (interface-ready; full schema migration is Step 5+).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)


@dataclass
class StructuredFacts:
    cart_count: int = 0
    cart_confirmed: bool = False
    payment_flow_status: str = "idle"
    email_confirmed: bool = False
    awaiting_email_confirmation: bool = False
    order_context: str = ""
    facility_context: str = ""
    isbns: list[str] = field(default_factory=list)


@dataclass
class MemorySnapshot:
    rolling_summary: str = ""
    facts: list[str] = field(default_factory=list)
    structured: StructuredFacts = field(default_factory=StructuredFacts)
    safe_summary: str = ""
    turn_count: int = 0
    customer_profile_hint: str = ""


class MemoryManager:
    """Single entry point for orchestrator and legacy runtime memory."""

    @staticmethod
    def load(session: "SessionState") -> MemorySnapshot:
        from ..agent_runtime.call_memory_manager import CallMemoryManager
        from ..conversation.call_memory import get_call_memory, sync_from_session

        sync_from_session(session)
        state = get_call_memory(session)
        packet = CallMemoryManager.build_packet(session)

        structured = StructuredFacts(
            cart_count=_cart_count(session),
            cart_confirmed=bool(getattr(session, "payment_cart_confirmed", False)),
            payment_flow_status=getattr(session, "payment_flow_status", "") or "idle",
            email_confirmed=bool(getattr(session, "payment_email_confirmed", False)),
            awaiting_email_confirmation=bool(
                getattr(session, "awaiting_payment_email_confirmation", False)
            ),
            order_context=state.order_context or "",
            facility_context=state.facility_context or getattr(session, "last_facility_name", ""),
            isbns=list(state.isbns_provided or []),
        )

        safe = MemoryManager.safe_summary(session, structured=structured, packet=packet)
        profile = _customer_profile_hint(session)

        return MemorySnapshot(
            rolling_summary=state.rolling_summary or "",
            facts=list(state.important_facts or []),
            structured=structured,
            safe_summary=safe,
            turn_count=len(state.user_turns or []),
            customer_profile_hint=profile,
        )

    @staticmethod
    def safe_summary(
        session: "SessionState",
        *,
        structured: Optional[StructuredFacts] = None,
        packet: Any = None,
    ) -> str:
        snap = structured or MemoryManager.load(session).structured
        parts: list[str] = []
        if snap.cart_count:
            parts.append(f"cart_books={snap.cart_count}")
        if snap.cart_confirmed:
            parts.append("cart_confirmed=yes")
        if snap.payment_flow_status != "idle":
            parts.append(f"payment_flow={snap.payment_flow_status}")
        if snap.email_confirmed:
            parts.append("email_confirmed=yes")
        elif snap.awaiting_email_confirmation:
            parts.append("awaiting_email_confirmation=yes")
        if snap.order_context:
            parts.append(f"order={snap.order_context[:30]}")
        if snap.facility_context:
            parts.append(f"facility={snap.facility_context[:30]}")
        if snap.isbns:
            parts.append(f"isbns={len(snap.isbns)}")
        if getattr(session, "last_selected_title", ""):
            parts.append(f"last_book={session.last_selected_title[:40]}")
        return "; ".join(parts) if parts else "new_call"

    @staticmethod
    def record_turn(
        session: "SessionState",
        user_text: str,
        assistant_text: str,
        *,
        source: str = "orchestrator",
        turn_id: str = "",
    ) -> None:
        from ..agent_runtime.call_memory_manager import CallMemoryManager

        CallMemoryManager.update_after_turn(session, user_text, assistant_text, source)
        MemoryManager._sync_structured_facts(session)
        MemoryManager._maybe_persist_postgres(
            session, user_text, assistant_text, source=source, turn_id=turn_id
        )
        MemoryManager._maybe_persist_session(session)

    @staticmethod
    def resume_snapshot(session: "SessionState") -> dict[str, Any]:
        from ..conversation.call_memory import store_resume_snapshot

        return store_resume_snapshot(session) or {}

    @staticmethod
    def _sync_structured_facts(session: "SessionState") -> None:
        from ..conversation.call_memory import get_call_memory

        state = get_call_memory(session)
        if getattr(session, "payment_email_confirmed", False):
            state.email_state = "confirmed"
        elif getattr(session, "awaiting_payment_email_confirmation", False):
            state.email_state = "awaiting_confirmation"
        elif getattr(session, "pending_payment_email", ""):
            state.email_state = "pending"
        pfs = getattr(session, "payment_flow_status", "") or "idle"
        if pfs != "idle":
            state.important_facts = [
                f for f in state.important_facts if not f.startswith("payment:")
            ]
            state.important_facts.append(f"payment:{pfs}")

    @staticmethod
    def _maybe_persist_session(session: "SessionState") -> None:
        try:
            from ..config import get_settings

            if not get_settings().DATABASE_URL:
                return
            from ..memory.postgres_store import persist_call_session_if_configured

            persist_call_session_if_configured(session)
        except Exception as exc:
            logger.debug("postgres_session_persist_skipped err=%s", type(exc).__name__)

    @staticmethod
    def _maybe_persist_postgres(
        session: "SessionState",
        user_text: str,
        assistant_text: str,
        *,
        source: str,
        turn_id: str = "",
    ) -> None:
        try:
            from ..config import get_settings

            if not get_settings().DATABASE_URL:
                return
            from ..memory.postgres_store import persist_turn_if_configured

            persist_turn_if_configured(
                session,
                user_text=user_text,
                assistant_text=assistant_text,
                source=source,
                turn_id=turn_id,
            )
        except Exception as exc:
            logger.debug("postgres_persist_skipped err=%s", type(exc).__name__)


def _cart_count(session: "SessionState") -> int:
    try:
        from ..cart.session import get_ledger

        return get_ledger(session).confirmed_count()
    except Exception:  # noqa: BLE001
        return len(getattr(session, "cart_items", None) or [])


def _customer_profile_hint(session: "SessionState") -> str:
    name = (getattr(session, "caller_name", "") or "").strip()
    if name:
        return f"returning_name={name[:20]}"
    return ""
