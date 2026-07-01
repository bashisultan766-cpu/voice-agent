"""
TraceLogger — structured per-turn pipeline trace with latency breakdown.
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Optional

logger = logging.getLogger(__name__)


@dataclass
class TraceStage:
    name: str
    elapsed_ms: int
    data: dict[str, Any] = field(default_factory=dict)


@dataclass
class TurnTrace:
    call_sid: str
    turn_id: int
    user_text: str
    version: str = "v2.1"
    started_at: float = field(default_factory=time.monotonic)
    stages: list[TraceStage] = field(default_factory=list)
    policy: dict[str, Any] = field(default_factory=dict)
    planner_plan: dict[str, Any] = field(default_factory=dict)
    tool_chain: list[dict[str, Any]] = field(default_factory=list)
    composed_chars: int = 0
    emit_discarded: bool = False
    total_ms: int = 0

    def mark(self, name: str, data: Optional[dict[str, Any]] = None) -> None:
        elapsed = int((time.monotonic() - self.started_at) * 1000)
        self.stages.append(TraceStage(name=name, elapsed_ms=elapsed, data=dict(data or {})))

    def set_policy(self, decision: Any) -> None:
        self.policy = {
            "overridden": getattr(decision, "overridden", False),
            "reason": getattr(decision, "reason", ""),
            "policy_id": getattr(decision, "policy_id", ""),
            "plan": getattr(getattr(decision, "plan", None), "to_dict", lambda: {})(),
        }

    def set_planner_plan(self, plan: Any) -> None:
        self.planner_plan = plan.to_dict() if hasattr(plan, "to_dict") else {}

    def append_tool_step(self, step: dict[str, Any]) -> None:
        self.tool_chain.append(step)

    def finish(self) -> dict[str, Any]:
        self.total_ms = int((time.monotonic() - self.started_at) * 1000)
        payload = {
            "version": self.version,
            "call_sid": self.call_sid[:6],
            "turn_id": self.turn_id,
            "user_text_len": len(self.user_text),
            "total_ms": self.total_ms,
            "stages": [
                {"name": s.name, "elapsed_ms": s.elapsed_ms, **({"data": s.data} if s.data else {})}
                for s in self.stages
            ],
            "policy": self.policy,
            "planner_plan": self.planner_plan,
            "tool_chain": self.tool_chain,
            "composed_chars": self.composed_chars,
            "emit_discarded": self.emit_discarded,
        }
        logger.info("v2_turn_trace %s", json.dumps(payload, ensure_ascii=False, default=str))
        return payload


class TraceLogger:
    """Factory for per-turn traces."""

    VERSION = "v2.1"

    @staticmethod
    def start(call_sid: str, turn_id: int, user_text: str) -> TurnTrace:
        return TurnTrace(
            call_sid=call_sid,
            turn_id=turn_id,
            user_text=user_text,
            version=TraceLogger.VERSION,
        )
