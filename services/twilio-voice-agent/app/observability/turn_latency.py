"""Per-turn latency breakdown for orchestrator and dispatch."""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class TurnLatency:
    stt_to_turn_ms: float = 0.0
    supervisor_ms: float = 0.0
    planner_ms: float = 0.0
    tool_router_ms: float = 0.0
    tool_total_ms: float = 0.0
    response_composer_ms: float = 0.0
    total_turn_ms: float = 0.0

    def log(self, *, call_sid: str = "", handler: str = "orchestrator") -> None:
        logger.info(
            "turn_latency handler=%s call_sid=%s "
            "stt_to_turn_ms=%.0f supervisor_ms=%.0f planner_ms=%.0f "
            "tool_router_ms=%.0f tool_total_ms=%.0f response_composer_ms=%.0f total_turn_ms=%.0f",
            handler,
            (call_sid or "")[:8],
            self.stt_to_turn_ms,
            self.supervisor_ms,
            self.planner_ms,
            self.tool_router_ms,
            self.tool_total_ms,
            self.response_composer_ms,
            self.total_turn_ms,
        )
