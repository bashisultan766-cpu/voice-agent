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

        logger.info(
            "memory_packet_built sid=%s turns=%d facts=%d",
            session.call_sid[:6],
            len(packet.recent_turns),
            len(packet.facts),
        )
        return packet

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
