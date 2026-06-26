"""Orchestrator types — structured supervisor/planner/tool/compose contracts."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

VALID_INTENTS = frozenset({
    "product_search",
    "product_request_clarification",
    "cart_update",
    "checkout_payment",
    "order_status",
    "refund_status",
    "facility_question",
    "shipping_question",
    "faq",
    "identity_email_collection",
    "smalltalk",
    "escalation",
    "unknown",
})

VALID_RISK_LEVELS = frozenset({"low", "medium", "high"})


@dataclass
class SupervisorResult:
    intent: str = "unknown"
    confidence: float = 0.0
    needs_tools: bool = False
    needs_planner: bool = False
    risk_level: str = "low"
    clarifying_question: Optional[str] = None
    allowed_tool_categories: list[str] = field(default_factory=list)
    reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "intent": self.intent,
            "confidence": round(self.confidence, 3),
            "needs_tools": self.needs_tools,
            "needs_planner": self.needs_planner,
            "risk_level": self.risk_level,
            "clarifying_question": self.clarifying_question,
            "allowed_tool_categories": list(self.allowed_tool_categories),
            "reason": self.reason,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SupervisorResult":
        intent = data.get("intent") or "unknown"
        if intent not in VALID_INTENTS:
            intent = "unknown"
        risk = data.get("risk_level") or "low"
        if risk not in VALID_RISK_LEVELS:
            risk = "low"
        return cls(
            intent=intent,
            confidence=float(data.get("confidence") or 0.0),
            needs_tools=bool(data.get("needs_tools")),
            needs_planner=bool(data.get("needs_planner")),
            risk_level=risk,
            clarifying_question=data.get("clarifying_question"),
            allowed_tool_categories=list(data.get("allowed_tool_categories") or []),
            reason=str(data.get("reason") or ""),
        )


@dataclass
class PlanStep:
    tool: str
    args: dict[str, Any] = field(default_factory=dict)
    depends_on: list[str] = field(default_factory=list)
    can_run_parallel: bool = True


@dataclass
class PlannerResult:
    steps: list[PlanStep] = field(default_factory=list)
    requires_confirmation_before_execution: bool = False
    customer_facing_progress_message: str = ""
    blocked: bool = False
    block_reason: str = ""
    customer_message: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "steps": [
                {
                    "tool": s.tool,
                    "args": s.args,
                    "depends_on": s.depends_on,
                    "can_run_parallel": s.can_run_parallel,
                }
                for s in self.steps
            ],
            "requires_confirmation_before_execution": self.requires_confirmation_before_execution,
            "customer_facing_progress_message": self.customer_facing_progress_message,
        }


@dataclass
class ToolExecutionResult:
    tool: str
    success: bool
    result: dict[str, Any] = field(default_factory=dict)
    raw_json: str = ""
    error_code: str = ""
    latency_ms: float = 0.0
    blocked_by_guard: bool = False


@dataclass
class OrchestratorTurnContext:
    user_text: str = ""
    turn_id: str = ""
    turn_mode: str = ""
    memory_summary: str = ""
    supervisor: Optional[SupervisorResult] = None
    planner: Optional[PlannerResult] = None
    tool_results: list[ToolExecutionResult] = field(default_factory=list)
