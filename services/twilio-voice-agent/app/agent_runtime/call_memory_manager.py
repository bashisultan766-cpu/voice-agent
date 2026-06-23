"""Call memory manager for Eric Agent Runtime (v4.11)."""
from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING, Optional

from .memory_packet import MemoryPacket

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_REPEAT_CLARIFICATION_PAT = re.compile(
    r"\b("
    r"what did you say|what you say|say that again|repeat that|"
    r"you are what|your what|it(?:'s| is) your what|"
    r"i didn(?:'|')?t hear you|didn(?:'|')?t catch that|"
    r"what was your name|what is your name again|can you repeat|"
    r"pardon|come again|sorry what"
    r")\b",
    re.I,
)


def _mask_for_log(text: str) -> str:
    if not text:
        return ""
    masked = re.sub(
        r"[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}",
        "***@***",
        text,
        flags=re.IGNORECASE,
    )
    masked = re.sub(
        r"(?:\+1)?[\s.\-]?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}",
        "***-***-****",
        masked,
    )
    if len(masked) > 80:
        return masked[:77] + "..."
    return masked


def is_repeat_or_clarification_request(text: str) -> bool:
    """Detect when the caller wants the last assistant response repeated."""
    return bool(_REPEAT_CLARIFICATION_PAT.search((text or "").strip()))


def get_last_assistant_response(session: "SessionState") -> str:
    """Return the most recent assistant turn from call memory."""
    from ..conversation.call_memory import get_call_memory, sync_from_session

    sync_from_session(session)
    state = get_call_memory(session)
    assistants = state.assistant_turns or []
    return assistants[-1].strip() if assistants else ""


class CallMemoryManager:
    """Enhanced per-call memory for v4.11 runtime."""

    @staticmethod
    def build_packet(session: "SessionState", max_turns: int = 50) -> MemoryPacket:
        from ..conversation.call_memory import get_call_memory, sync_from_session

        sync_from_session(session)
        state = get_call_memory(session)
        packet = MemoryPacket(
            rolling_summary=state.rolling_summary,
            facts=list(state.important_facts),
            isbns=list(state.isbns_provided),
            email_state=state.email_state,
            order_context=state.order_context,
            facility_context=state.facility_context,
            customer_mood=state.customer_mood,
            turn_count=len(state.user_turns),
        )

        pfs = getattr(session, "payment_flow_status", "idle") or "idle"
        if pfs != "idle":
            packet.payment_state = pfs

        users = state.user_turns[-max_turns:]
        assistants = state.assistant_turns[-max_turns:]
        for i, ut in enumerate(users):
            ast = assistants[i] if i < len(assistants) else ""
            packet.recent_turns.append((ut, ast))

        if assistants:
            packet.last_assistant_response = assistants[-1].strip()

        _enrich_verified_call_context(packet, session)

        logger.info(
            "memory_packet_built sid=%s turns=%d facts=%d verified_prior=%s",
            session.call_sid[:6],
            len(packet.recent_turns),
            len(packet.facts),
            packet.can_reference_prior_call,
        )
        return packet

    @staticmethod
    def memory_answer_for_question(text: str, packet: MemoryPacket) -> str | None:
        """Deterministic safe answer for memory questions."""
        import re

        t = (text or "").strip()
        if not re.search(
            r"\b(remember me|do you remember|spoke with you|talked to you|called before|"
            r"last year|previous call|you remember my)\b",
            t,
            re.I,
        ):
            return None

        if re.search(r"\blast year\b|\blong ago\b|\bfar back\b", t, re.I):
            if not packet.can_reference_prior_call:
                return (
                    "I may not have the details from a call that far back, but I can help you now."
                )

        if packet.can_reference_prior_call and packet.safe_memory_summary:
            return (
                f"I can see we spoke recently about {packet.safe_memory_summary}. "
                "How can I help you today?"
            )

        return (
            "I may not have the details from that call, but I'm here now. How can I help?"
        )

    @staticmethod
    def record_fact(session: "SessionState", fact_type: str, detail: str = "") -> None:
        from ..conversation.call_memory import record_brain_fact

        record_brain_fact(session, fact_type if not detail else f"{fact_type}_{detail}"[:40])
        logger.info(
            "memory_fact_extracted sid=%s type=%s",
            session.call_sid[:6],
            fact_type,
        )

    @staticmethod
    def update_after_turn(
        session: "SessionState",
        user_text: str,
        assistant_text: str,
        intent: str = "",
    ) -> None:
        from ..conversation.call_memory import (
            record_user_turn,
            record_assistant_turn,
            extract_turn_facts,
        )

        record_user_turn(session, user_text, intent)
        if assistant_text:
            record_assistant_turn(session, assistant_text)
        extract_turn_facts(session, intent, user_text)

    @staticmethod
    def log_supervisor_use(session: "SessionState") -> None:
        logger.debug("memory_used_by_supervisor sid=%s", session.call_sid[:6])

    @staticmethod
    def log_composer_use(session: "SessionState") -> None:
        logger.debug("memory_used_by_final_composer sid=%s", session.call_sid[:6])

    @staticmethod
    def safe_log_text(text: str) -> str:
        return _mask_for_log(text)


def _enrich_verified_call_context(packet: MemoryPacket, session: "SessionState") -> None:
    """Populate verified prior-call fields from session resume context."""
    import time

    from ..config import get_settings

    resumed = bool(getattr(session, "is_resumed_call", False))
    resume_ctx = bool(getattr(session, "resume_context_available", False))
    if not resumed and not resume_ctx:
        return

    s = get_settings()
    window = getattr(s, "CALL_RESUME_WINDOW_MINUTES", 30)
    ended_at = getattr(session, "prior_call_ended_at", 0.0) or 0.0
    age_min = 0.0
    if ended_at > 0:
        age_min = (time.time() - ended_at) / 60.0
    elif getattr(session, "prior_call_age_minutes", None):
        age_min = float(session.prior_call_age_minutes)

    if age_min > window and age_min > 0:
        packet.has_verified_recent_call = False
        packet.can_reference_prior_call = False
        return

    packet.has_verified_recent_call = True
    packet.prior_call_age_minutes = age_min
    packet.can_reference_prior_call = True

    topic = ""
    state = getattr(session, "call_memory", None)
    if state:
        topic = getattr(state, "current_topic", "") or ""
    if not topic and packet.facts:
        topic = packet.facts[-1][:80]
    if not topic and packet.order_context:
        topic = f"order {packet.order_context[:20]}"
    packet.safe_memory_summary = topic or "your recent request"
