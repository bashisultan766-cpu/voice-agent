"""
Structured workflow-transition events — side-effect only observability.

Events never influence business logic; they exist for debugging and tracing.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Literal, TypedDict

logger = logging.getLogger(__name__)

WORKFLOW_EVENTS_VERSION = "v1.0"

WorkflowDomain = Literal["product_search", "order", "support", "unknown"]
WorkflowInputType = Literal["isbn", "title", "fallback", "email", "unknown"]
WorkflowOutcome = Literal["success", "fail", "escalate", "clarify", "unknown"]

# Canonical step names (required events)
STEP_PRODUCT_SEARCH_STARTED = "product_search_started"
STEP_PRODUCT_MATCH_ATTEMPTED = "product_match_attempted"
STEP_PRODUCT_EXACT_MATCH_FOUND = "product_exact_match_found"
STEP_PRODUCT_SIMILARITY_FALLBACK_USED = "product_similarity_fallback_used"
STEP_PRODUCT_HANDOFF_STAGED = "product_handoff_staged"
STEP_SUPPORT_HANDOFF_TRIGGERED = "support_handoff_triggered"
STEP_EMAIL_CAPTURED_SILENTLY = "email_captured_silently"
STEP_WORKFLOW_VIOLATION_DETECTED = "workflow_violation_detected"
STEP_ESCALATION_LOOP_DETECTED = "escalation_loop_detected"
STEP_LEGACY_ROUTE_ATTEMPT_DETECTED = "legacy_route_attempt_detected"
STEP_WORKFLOW_COMPILE_RUNTIME_VIOLATION = "workflow_compile_runtime_violation"


class WorkflowTransitionEvent(TypedDict, total=False):
    event_type: Literal["workflow_transition"]
    domain: WorkflowDomain
    step: str
    input_type: WorkflowInputType
    outcome: WorkflowOutcome
    metadata: dict[str, Any]


def _sid(session: Any) -> str:
    return (getattr(session, "call_sid", "") or "")[:8]


def _session_id(session: Any) -> str:
    return (getattr(session, "session_id", "") or getattr(session, "call_sid", "") or "")[:12]


def _normalize_domain(domain: str) -> WorkflowDomain:
    raw = (domain or "").strip().lower()
    if raw in ("product_search", "product_search_workflow"):
        return "product_search"
    if raw in ("order", "order_workflow"):
        return "order"
    if raw in ("support", "support_handoff", "support_handoff_workflow"):
        return "support"
    return "unknown"


def emit_event(event: WorkflowTransitionEvent, *, session: Any = None) -> None:
    """
    Emit a structured workflow transition event.

    Side-effect only — must never change control flow except via logging.
    """
    payload: dict[str, Any] = {
        "event_type": event.get("event_type") or "workflow_transition",
        "domain": _normalize_domain(str(event.get("domain") or "unknown")),
        "step": str(event.get("step") or ""),
        "input_type": event.get("input_type") or "unknown",
        "outcome": event.get("outcome") or "unknown",
        "metadata": dict(event.get("metadata") or {}),
        "version": WORKFLOW_EVENTS_VERSION,
    }
    if session is not None:
        payload["metadata"].setdefault("call_sid", _sid(session))
        payload["metadata"].setdefault("session_id", _session_id(session))

    logger.info(
        "workflow_transition step=%s domain=%s input_type=%s outcome=%s payload=%s",
        payload["step"],
        payload["domain"],
        payload["input_type"],
        payload["outcome"],
        json.dumps(payload, default=str, separators=(",", ":")),
    )
