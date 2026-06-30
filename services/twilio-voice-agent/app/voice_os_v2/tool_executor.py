"""Isolated tool sandbox — raw structured data only, no speech."""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Optional

from .session_state import V2SessionState
from .types import Plan, PlanAction, ToolChainResult, ToolExecutionResult

logger = logging.getLogger(__name__)

MAX_TOOL_CHAIN_STEPS = 3

_ALLOWED_TOOLS = frozenset({
    "search_product_by_isbn",
    "catalog_search",
    "search_products",
    "get_cart",
    "add_to_cart",
    "update_cart",
    "remove_from_cart",
    "send_payment_link",
    "lookup_shopify_order_details",
    "lookup_order_status",
    "lookup_refund_status",
    "facility_policy_lookup",
    "escalate_to_customer_service",
    "create_product_not_found_escalation",
})


@dataclass
class _EphemeralToolSession:
    """Minimal bridge for shopify tool implementations — never persisted directly."""

    call_sid: str
    cart_items: list[dict[str, Any]] = field(default_factory=list)
    confirmed_email: str = ""
    pending_email: str = ""
    payment_flow_status: str = "idle"
    payment_email_confirmed: bool = False
    payment_cart_confirmed: bool = False
    last_order_number: str = ""
    order_flow_status: str = "idle"
    payment_email_sent_to: list[str] = field(default_factory=list)
    pending_checkout_url: str = ""
    history: list[dict[str, Any]] = field(default_factory=list)


def _bridge_from_v2(state: V2SessionState) -> _EphemeralToolSession:
    return _EphemeralToolSession(
        call_sid=state.call_sid,
        cart_items=list(state.cart),
        confirmed_email=state.email.confirmed,
        pending_email=state.email.pending,
        payment_email_confirmed=bool(state.email.confirmed),
        payment_cart_confirmed=bool(state.cart),
        last_order_number=state.order_context.last_number,
        payment_flow_status="awaiting_send_confirmation" if state.email.confirmed else "idle",
        history=list(state.history),
    )


def _extract_patches(
    tool: str,
    data: dict[str, Any],
    bridge: _EphemeralToolSession,
    prior_cart: list[dict[str, Any]],
) -> dict[str, Any]:
    patches: dict[str, Any] = {"last_tool_result": {"tool": tool, "data": data}}

    if bridge.cart_items != prior_cart:
        patches["cart"] = list(bridge.cart_items)
        patches["conversation_stage"] = "cart_review"

    if tool in ("search_product_by_isbn", "catalog_search", "search_products"):
        product = data.get("product") or {}
        if not product and data.get("results"):
            results = data["results"]
            product = results[0] if results else {}
        if product.get("variant_id") or product.get("title"):
            patches["metadata"] = {
                "last_product": {
                    "title": product.get("title", ""),
                    "variant_id": product.get("variant_id", ""),
                    "isbn": product.get("isbn", ""),
                    "price": product.get("price", ""),
                }
            }

    if tool == "lookup_shopify_order_details" and data.get("order_number"):
        patches["order_context"] = {
            "last_number": str(data.get("order_number", "")),
            "last_lookup": data,
            "verified_numbers": list(
                set(bridge.last_order_number.split()) | {str(data.get("order_number", ""))}
            ),
        }

    if tool == "send_payment_link" and data.get("success"):
        patches["conversation_stage"] = "closing"
        patches["metadata"] = {"payment_sent": True}

    return patches


class ToolExecutor:
    """Sandboxed tool runner — no customer-facing text, no nested tool calls."""

    async def run_chain(
        self,
        initial_plan: "Plan",
        state: V2SessionState,
        planner: Any,
        *,
        user_text: str = "",
        policy_gate: Any = None,
    ) -> ToolChainResult:
        """
        Execute up to MAX_TOOL_CHAIN_STEPS tools. Re-consults planner followup only
        when deterministic exit conditions are not met.
        """
        from .types import PlanAction

        if initial_plan.action != PlanAction.TOOL or not initial_plan.tool:
            return ToolChainResult(exit_reason="no_tool_plan")

        results: list[ToolExecutionResult] = []
        seen: set[str] = set()
        working = state
        current_tool = initial_plan.tool
        current_args = dict(initial_plan.args or {})

        for step in range(1, MAX_TOOL_CHAIN_STEPS + 1):
            sig = f"{current_tool}:{json.dumps(current_args, sort_keys=True)}"
            if sig in seen:
                return ToolChainResult(
                    results=results,
                    state_patches=_merge_results_patches(results),
                    steps_executed=len(results),
                    exit_reason="duplicate_tool_signature",
                )
            seen.add(sig)

            result = await self.run(current_tool, current_args, working)
            result.step = step
            results.append(result)

            if not result.ok:
                return ToolChainResult(
                    results=results,
                    state_patches=_merge_results_patches(results),
                    steps_executed=len(results),
                    exit_reason="tool_failed",
                )

            working = _apply_ephemeral(working, result.state_patches)

            followup = planner.plan_tool_followup(working, result, user_text)
            if followup is None or followup.action != PlanAction.TOOL:
                return ToolChainResult(
                    results=results,
                    state_patches=_merge_results_patches(results),
                    steps_executed=len(results),
                    exit_reason="followup_none",
                )

            if policy_gate is not None:
                gate = policy_gate.gate_tool_plan(working, followup)
                if gate.overridden and gate.plan:
                    return ToolChainResult(
                        results=results,
                        state_patches=_merge_results_patches(results),
                        steps_executed=len(results),
                        exit_reason="policy_blocked_followup",
                    )

            current_tool = followup.tool
            current_args = dict(followup.args or {})

        return ToolChainResult(
            results=results,
            state_patches=_merge_results_patches(results),
            steps_executed=len(results),
            exit_reason="max_steps",
        )

    async def run(
        self,
        tool: str,
        args: dict[str, Any],
        state: V2SessionState,
    ) -> ToolExecutionResult:
        name = (tool or "").strip()
        if name not in _ALLOWED_TOOLS:
            return ToolExecutionResult(
                tool=name,
                ok=False,
                error=f"tool_not_allowed:{name}",
            )

        bridge = _bridge_from_v2(state)
        prior_cart = list(bridge.cart_items)

        if name == "send_payment_link" and not bridge.confirmed_email:
            return ToolExecutionResult(
                tool=name,
                ok=False,
                error="email_not_confirmed",
                data={"error_code": "email_not_confirmed"},
            )

        if name == "lookup_shopify_order_details":
            onum = str(args.get("order_number", "") or state.order_context.last_number)
            if onum and onum not in (state.order_context.verified_numbers or []):
                if onum != str(args.get("order_number", "")):
                    pass
                bridge.last_order_number = onum

        try:
            raw = await self._dispatch(name, args, bridge)
            data = json.loads(raw) if isinstance(raw, str) else dict(raw or {})
        except json.JSONDecodeError:
            data = {"raw": raw}
        except Exception as exc:
            logger.exception("v2_tool_error tool=%s", name)
            return ToolExecutionResult(tool=name, ok=False, error=type(exc).__name__)

        ok = not data.get("error") and data.get("error_code") is None
        if name == "send_payment_link":
            ok = bool(data.get("success") or data.get("email_sent"))

        patches = _extract_patches(name, data, bridge, prior_cart)

        if name in ("search_product_by_isbn", "catalog_search") and ok:
            meta = patches.get("metadata", {}).get("last_product", {})
            if meta.get("variant_id"):
                patches.setdefault("metadata", {})["suggest_add"] = meta

        return ToolExecutionResult(
            tool=name,
            ok=ok,
            data=data,
            state_patches=patches,
        )

    async def _dispatch(
        self,
        name: str,
        args: dict[str, Any],
        bridge: _EphemeralToolSession,
    ) -> str:
        from pydantic import ValidationError

        from ..agent_runtime import llm_tools

        tool = llm_tools._TOOLS.get(name)  # noqa: SLF001 — v2 sandbox entry
        if tool is None:
            raise ValueError(f"unknown_tool:{name}")
        try:
            validated = tool.model(**dict(args or {}))
        except ValidationError as exc:
            return json.dumps({"error": "invalid_args", "detail": exc.errors()})
        result = await tool.impl(validated, bridge)  # type: ignore[arg-type]
        return result if isinstance(result, str) else json.dumps(result)


def _merge_results_patches(results: list[ToolExecutionResult]) -> dict[str, Any]:
    merged: dict[str, Any] = {}
    for r in results:
        if r.state_patches:
            merged.update(r.state_patches)
    return merged


def _apply_ephemeral(state: V2SessionState, patches: dict[str, Any]) -> V2SessionState:
    """In-memory copy for chain stepping — not persisted until TurnController commit."""
    from copy import deepcopy

    clone = deepcopy(state)
    clone.apply_patches(patches)
    return clone

