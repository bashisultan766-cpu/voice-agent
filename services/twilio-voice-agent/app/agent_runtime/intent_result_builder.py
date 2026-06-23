"""Build IntentResult from MainLLMAgent decisions (v4.14.4)."""
from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from ..pipeline.router import IntentResult, detect as router_detect
from .tool_entity_extractor import extract_tool_entities

if TYPE_CHECKING:
    from ..state.models import SessionState
    from .memory_packet import MemoryPacket


def _build_intent_result_from_agent_decision(
    decision: dict,
    user_text: str,
    session: Optional["SessionState"] = None,
    memory_packet: Optional["MemoryPacket"] = None,
) -> IntentResult:
    """Populate intent, confidence, and entities for worker fanout."""
    intent = str(decision.get("intent") or "unknown")
    confidence = float(decision.get("confidence") or 0.95)

    entities = extract_tool_entities(
        user_text,
        decision=decision,
        memory_packet=memory_packet,
        session=session,
    )

    detected = router_detect(user_text, session)
    for key, value in detected.entities.items():
        if key not in entities and value:
            entities[key] = value

    entities["raw_text"] = user_text
    entities["intent"] = intent

    return IntentResult(
        intent=intent,
        confidence=confidence,
        entities=entities,
    )
