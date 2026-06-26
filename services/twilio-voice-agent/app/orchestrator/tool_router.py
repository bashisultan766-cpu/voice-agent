"""Tool router — maps planner steps to llm_tools with Step 2 guards."""
from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Optional

from .types import PlanStep, ToolExecutionResult

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

# Planner tool name → llm_tools registry name (1:1 for most tools).
_TOOL_ALIASES: dict[str, str] = {
    "search_products": "search_products",
    "catalog_search": "catalog_search",
    "get_cart": "get_cart",
    "add_to_cart": "add_to_cart",
    "create_checkout": "create_checkout",
    "send_payment_link": "send_payment_link",
    "lookup_order_status": "lookup_order_status",
    "lookup_refund_status": "lookup_refund_status",
    "facility_policy_lookup": "facility_policy_lookup",
    "search_facility_policy": "search_facility_policy",
    "check_facility_content_allowed": "check_facility_content_allowed",
    "explain_facility_restriction": "explain_facility_restriction",
    "fetch_facility_policy_analysis": "fetch_facility_policy_analysis",
    "answer_facility_policy_question": "answer_facility_policy_question",
    "explain_facility_delivery_rejection": "explain_facility_delivery_rejection",
    "classify_product_content_for_facility": "classify_product_content_for_facility",
    "shipping_policy_lookup": "shipping_policy_lookup",
    "faq_lookup": "faq_lookup",
    "escalate_to_human": "escalate_to_human",
    "create_product_not_found_escalation": "create_product_not_found_escalation",
}

_READ_ONLY_TOOLS = frozenset({
    "search_products",
    "catalog_search",
    "get_product_details",
    "compare_products",
    "get_cart",
    "lookup_order_status",
    "lookup_refund_status",
    "shipping_policy_lookup",
    "refund_policy_lookup",
    "facility_policy_lookup",
    "search_facility_policy",
    "check_facility_content_allowed",
    "explain_facility_restriction",
    "fetch_facility_policy_analysis",
    "answer_facility_policy_question",
    "explain_facility_delivery_rejection",
    "classify_product_content_for_facility",
    "faq_lookup",
    "get_caller_info",
    "create_product_not_found_escalation",
})


def resolve_tool_name(planner_tool: str) -> str:
    return _TOOL_ALIASES.get(planner_tool, planner_tool)


def is_read_only_tool(tool_name: str) -> bool:
    return resolve_tool_name(tool_name) in _READ_ONLY_TOOLS


async def execute_step(
    step: PlanStep,
    session: "SessionState",
    *,
    turn_id: str = "",
    timeout_ms: Optional[int] = None,
) -> ToolExecutionResult:
    """Execute one planner step through the canonical llm_tools dispatch path."""
    import asyncio
    import time

    from ..agent_runtime import llm_tools
    from ..agent_runtime.tool_runtime_gates import gate_tool_call
    from ..observability.tool_events import log_tool_blocked, tool_event

    tool_name = resolve_tool_name(step.tool)
    t0 = time.monotonic()

    from ..workflow.hooks import schedule_workflow_event

    schedule_workflow_event(
        session,
        "tool_started",
        {"tool": tool_name, "args_keys": list((step.args or {}).keys())},
        turn_id=turn_id,
    )

    gate = gate_tool_call(tool_name, session)
    if gate is not None and not gate.allowed:
        log_tool_blocked(session=session, tool_name=tool_name, reason=gate.reason, turn_id=turn_id)
        try:
            parsed = json.loads(gate.tool_json)
        except json.JSONDecodeError:
            parsed = {"success": False, "error_code": gate.reason}
        return ToolExecutionResult(
            tool=tool_name,
            success=False,
            result=parsed,
            raw_json=gate.tool_json,
            error_code=gate.reason,
            latency_ms=(time.monotonic() - t0) * 1000,
            blocked_by_guard=True,
        )

    timeout = (timeout_ms or 2500) / 1000

    try:
        with tool_event(session=session, tool_name=tool_name, turn_id=turn_id, external_service="shopify"):
            raw = await asyncio.wait_for(
                llm_tools.dispatch(tool_name, dict(step.args or {}), session),
                timeout=timeout,
            )
    except asyncio.TimeoutError:
        return ToolExecutionResult(
            tool=tool_name,
            success=False,
            result={"success": False, "error": "Tool timed out."},
            error_code="timeout",
            latency_ms=(time.monotonic() - t0) * 1000,
        )
    except Exception as exc:
        logger.warning("tool_router_error tool=%s err=%s", tool_name, type(exc).__name__)
        return ToolExecutionResult(
            tool=tool_name,
            success=False,
            result={"success": False, "error": "Tool failed."},
            error_code=type(exc).__name__,
            latency_ms=(time.monotonic() - t0) * 1000,
        )

    try:
        parsed = json.loads(raw) if isinstance(raw, str) else {}
    except json.JSONDecodeError:
        parsed = {"raw": raw}

    success = bool(parsed.get("success", True)) and "error" not in parsed
    if parsed.get("error_code"):
        success = False

    latency_ms = (time.monotonic() - t0) * 1000
    event_type = "tool_succeeded" if success else "tool_failed"
    schedule_workflow_event(
        session,
        event_type,
        {
            "tool": tool_name,
            "success": success,
            "error_code": str(parsed.get("error_code") or ""),
            "latency_ms": latency_ms,
        },
        turn_id=turn_id,
    )
    try:
        from ..memory.postgres_store import persist_tool_event_if_configured

        persist_tool_event_if_configured(
            session,
            tool_name=tool_name,
            success=success,
            latency_ms=latency_ms,
            error_code=str(parsed.get("error_code") or ""),
            turn_id=turn_id,
            input_data=dict(step.args or {}),
            output_data=parsed if isinstance(parsed, dict) else {},
        )
    except Exception:
        pass

    return ToolExecutionResult(
        tool=tool_name,
        success=success,
        result=parsed if isinstance(parsed, dict) else {},
        raw_json=raw if isinstance(raw, str) else json.dumps(parsed),
        error_code=str(parsed.get("error_code") or ""),
        latency_ms=latency_ms,
    )
