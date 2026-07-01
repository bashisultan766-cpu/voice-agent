"""Shared types for VOICE_AGENT_OS_V2."""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


class ConversationStage(str, Enum):
    IDLE = "idle"
    SHOPPING = "shopping"
    CART_REVIEW = "cart_review"
    EMAIL_CAPTURE = "email_capture"
    EMAIL_CONFIRM = "email_confirm"
    PAYMENT = "payment"
    ORDER_LOOKUP = "order_lookup"
    SUPPORT = "support"
    CLOSING = "closing"


class PlanAction(str, Enum):
    SPEAK = "speak"
    TOOL = "tool"
    LLM_PLAN = "llm_plan"
    END_CALL = "end_call"
    NOOP = "noop"


class ResponseMode(str, Enum):
    INSTANT = "instant"
    TOOL_RESULT = "tool_result"
    LLM = "llm"
    REPEAT_LAST = "repeat_last"
    INTERRUPT_ACK = "interrupt_ack"


@dataclass
class Plan:
    """Planner output — no speech, no tool execution."""

    action: PlanAction = PlanAction.LLM_PLAN
    tool: str = ""
    args: dict[str, Any] = field(default_factory=dict)
    response_mode: ResponseMode = ResponseMode.LLM
    instant_text: str = ""
    stage_hint: str = ""
    reason: str = ""
    # Planner must NOT mutate state — patches ignored if set by planner/rules.
    state_patches: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "action": self.action.value,
            "tool": self.tool,
            "args": self.args,
            "response_mode": self.response_mode.value,
            "instant_text": self.instant_text,
            "stage_hint": self.stage_hint,
            "reason": self.reason,
            "state_patches": self.state_patches,
        }


@dataclass
class ToolExecutionResult:
    """Raw tool output — no customer-facing text."""

    tool: str
    ok: bool
    data: dict[str, Any] = field(default_factory=dict)
    error: str = ""
    state_patches: dict[str, Any] = field(default_factory=dict)
    step: int = 0


@dataclass
class ToolChainResult:
    """Up to 3 tool steps — merged patches, no speech."""

    results: list[ToolExecutionResult] = field(default_factory=list)
    state_patches: dict[str, Any] = field(default_factory=dict)
    steps_executed: int = 0
    exit_reason: str = ""


@dataclass
class ComposedResponse:
    """Final text from ResponseComposer only."""

    text: str
    end_call: bool = False


@dataclass
class TurnResult:
    """Outcome returned to WebSocket layer."""

    response_text: str = ""
    turn_id: int = 0
    end_call: bool = False
    skipped: bool = False
    reason: str = ""


@dataclass
class EmitResult:
    spoken_epochs: list[int] = field(default_factory=list)
    discarded: bool = False
    chars: int = 0
