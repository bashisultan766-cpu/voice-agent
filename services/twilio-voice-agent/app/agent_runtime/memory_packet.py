"""MemoryPacket — per-call memory for Eric Agent Runtime (v4.11)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..state.models import SessionState


@dataclass
class MemoryPacket:
    recent_turns: list[tuple[str, str]] = field(default_factory=list)
    rolling_summary: str = ""
    facts: list[str] = field(default_factory=list)
    isbns: list[str] = field(default_factory=list)
    email_state: str = "none"
    payment_state: str = "none"
    order_context: str = ""
    facility_context: str = ""
    customer_mood: str = "normal"
    turn_count: int = 0
    last_assistant_response: str = ""

    def to_supervisor_context(self) -> str:
        parts: list[str] = []
        if self.rolling_summary:
            parts.append(f"[Earlier summary: {self.rolling_summary[:800]}]")
        for user, assistant in self.recent_turns[-12:]:
            parts.append(f"Customer: {user[:180]}")
            if assistant:
                parts.append(f"Eric: {assistant[:180]}")
        if self.facts:
            parts.append("[Facts: " + "; ".join(self.facts[-15:]) + "]")
        if self.isbns:
            parts.append(f"[ISBNs: {', '.join(self.isbns[-10:])}]")
        if self.email_state != "none":
            parts.append(f"[Email: {self.email_state}]")
        if self.payment_state != "none":
            parts.append(f"[Payment: {self.payment_state}]")
        if self.order_context:
            parts.append(f"[Order: {self.order_context}]")
        if self.facility_context:
            parts.append(f"[Facility: {self.facility_context}]")
        if self.customer_mood != "normal":
            parts.append(f"[Mood: {self.customer_mood}]")
        if self.last_assistant_response:
            parts.append(f"[Last Eric response: {self.last_assistant_response[:220]}]")
        return "\n".join(parts)

    def to_composer_context(self) -> str:
        return self.to_supervisor_context()


def build_memory_packet(session: "SessionState", max_turns: int = 50) -> MemoryPacket:
    from .call_memory_manager import CallMemoryManager
    return CallMemoryManager.build_packet(session, max_turns=max_turns)
