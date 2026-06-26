"""
Parallel tool router with safety gates for the Main Commerce Brain.

Validates tool arguments, applies payment/order privacy gates, executes
independent read-only tools in parallel, and returns structured results.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_READ_ONLY_TOOLS = frozenset({
    "search_products",
    "catalog_search",
    "get_product_details",
    "compare_products",
    "get_cart",
    "lookup_order_status",
    "lookup_refund_status",
    "get_order",
    "calculate_pricing",
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
    "lookup_customer_by_email_or_phone",
    "check_facility_approval",
    "check_order_facility_restrictions",
    "reconcile_order_facility_books",
})


@dataclass
class ToolCallResult:
    tool: str
    success: bool
    result: dict = field(default_factory=dict)
    raw_json: str = ""
    error_code: str = ""
    latency_ms: float = 0.0
    blocked_by_guard: bool = False


@dataclass
class ToolBatchResult:
    results: list[ToolCallResult] = field(default_factory=list)

    @property
    def tools_used(self) -> list[str]:
        return [r.tool for r in self.results]

    def parsed_pairs(self) -> list[tuple[str, dict]]:
        return [(r.tool, r.result) for r in self.results]


def is_read_only_tool(tool_name: str) -> bool:
    return tool_name in _READ_ONLY_TOOLS


async def execute_tool(
    tool_name: str,
    args: dict,
    session: "SessionState",
    *,
    turn_id: str = "",
    timeout_ms: Optional[int] = None,
    retry_transient: bool = True,
) -> ToolCallResult:
    """Execute one tool through canonical dispatch with safety gates."""
    from ..agent_runtime import llm_tools
    from ..agent_runtime.tool_runtime_gates import gate_tool_call
    from ..observability.tool_events import log_tool_blocked, tool_event

    t0 = time.monotonic()
    timeout = (timeout_ms or 2500) / 1000

    gate = gate_tool_call(tool_name, session)
    if gate is not None and not gate.allowed:
        log_tool_blocked(session=session, tool_name=tool_name, reason=gate.reason, turn_id=turn_id)
        try:
            parsed = json.loads(gate.tool_json)
        except json.JSONDecodeError:
            parsed = {"success": False, "error_code": gate.reason}
        return ToolCallResult(
            tool=tool_name,
            success=False,
            result=parsed,
            raw_json=gate.tool_json,
            error_code=gate.reason,
            latency_ms=(time.monotonic() - t0) * 1000,
            blocked_by_guard=True,
        )

    last_exc: Exception | None = None
    attempts = 2 if retry_transient else 1
    for attempt in range(attempts):
        try:
            with tool_event(session=session, tool_name=tool_name, turn_id=turn_id, external_service="shopify"):
                raw = await asyncio.wait_for(
                    llm_tools.dispatch(tool_name, dict(args or {}), session),
                    timeout=timeout,
                )
            try:
                parsed = json.loads(raw) if isinstance(raw, str) else {}
            except json.JSONDecodeError:
                parsed = {"raw": raw}

            success = bool(parsed.get("success", True)) and "error" not in parsed
            if parsed.get("error_code"):
                success = False

            return ToolCallResult(
                tool=tool_name,
                success=success,
                result=parsed,
                raw_json=raw if isinstance(raw, str) else json.dumps(parsed),
                error_code=str(parsed.get("error_code", "")),
                latency_ms=(time.monotonic() - t0) * 1000,
            )
        except asyncio.TimeoutError:
            if attempt + 1 < attempts:
                continue
            return ToolCallResult(
                tool=tool_name,
                success=False,
                result={"success": False, "error": "Tool timed out."},
                error_code="timeout",
                latency_ms=(time.monotonic() - t0) * 1000,
            )
        except Exception as exc:
            last_exc = exc
            if attempt + 1 < attempts:
                await asyncio.sleep(0.05)
                continue

    logger.warning("tool_router_error tool=%s err=%s", tool_name, type(last_exc).__name__ if last_exc else "unknown")
    return ToolCallResult(
        tool=tool_name,
        success=False,
        result={"success": False, "error": "Tool failed."},
        error_code=type(last_exc).__name__ if last_exc else "error",
        latency_ms=(time.monotonic() - t0) * 1000,
    )


async def execute_batch(
    calls: list[tuple[str, dict]],
    session: "SessionState",
    *,
    turn_id: str = "",
    timeout_ms: Optional[int] = None,
) -> ToolBatchResult:
    """Execute multiple tool calls; parallelize independent read-only tools."""
    if not calls:
        return ToolBatchResult()

    if len(calls) == 1:
        name, args = calls[0]
        result = await execute_tool(name, args, session, turn_id=turn_id, timeout_ms=timeout_ms)
        return ToolBatchResult(results=[result])

    all_read_only = all(is_read_only_tool(name) for name, _ in calls)
    if all_read_only:
        logger.info("tool_router_parallel count=%d", len(calls))
        results = await asyncio.gather(
            *[execute_tool(n, a, session, turn_id=turn_id, timeout_ms=timeout_ms) for n, a in calls],
            return_exceptions=True,
        )
        parsed: list[ToolCallResult] = []
        for item in results:
            if isinstance(item, Exception):
                parsed.append(ToolCallResult(
                    tool="unknown",
                    success=False,
                    result={"success": False, "error": str(item)},
                    error_code=type(item).__name__,
                ))
            else:
                parsed.append(item)
        return ToolBatchResult(results=parsed)

    batch: list[ToolCallResult] = []
    for name, args in calls:
        batch.append(await execute_tool(name, args, session, turn_id=turn_id, timeout_ms=timeout_ms))
    return ToolBatchResult(results=batch)


def tool_specs_for_brain() -> list[dict]:
    """OpenAI tool schemas exposed to Main Commerce Brain."""
    from ..agents.openai_tool_schema_adapter import get_main_brain_tool_specs

    return get_main_brain_tool_specs()
