"""
Hybrid planner — rules first, LLM fallback only when needed.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Optional

from .rules import evaluate_rules
from .session_state import V2SessionState
from .types import ConversationStage, Plan, PlanAction, ResponseMode, ToolExecutionResult

logger = logging.getLogger(__name__)

_PLANNER_SYSTEM = """You are the turn planner for SureShot Books voice agent.
Return ONLY valid JSON with keys: action, tool, args, response_mode, instant_text, stage_hint, reason.

action: one of speak | tool | end_call
tool: tool name or empty
args: object
response_mode: instant | tool_result | llm
instant_text: only when action=speak and response_mode=instant
stage_hint: idle | shopping | cart_review | email_capture | email_confirm | payment | order_lookup | support | closing

Allowed tools: search_product_by_isbn, catalog_search, add_to_cart, get_cart, send_payment_link,
lookup_shopify_order_details, facility_policy_lookup, escalate_to_customer_service

Never invent product or order data. Prefer tool when data is needed."""


class Planner:
    def __init__(self, settings=None):
        from ..config import get_settings

        self._settings = settings or get_settings()
        self._client = None

    def _get_client(self):
        if self._client is None:
            from openai import AsyncOpenAI

            self._client = AsyncOpenAI(api_key=self._settings.OPENAI_API_KEY)
        return self._client

    def _model(self) -> str:
        return (
            getattr(self._settings, "OPENAI_FAST_MODEL", "") or "gpt-4o-mini"
        ).strip()

    async def run(self, state: V2SessionState, user_text: str) -> Plan:
        ruled = evaluate_rules(state, user_text)
        if ruled is not None:
            logger.info(
                "v2_planner_rule sid=%s reason=%s action=%s",
                state.call_sid[:6],
                ruled.reason,
                ruled.action.value,
            )
            return ruled

        if not getattr(self._settings, "OPENAI_API_KEY", ""):
            return Plan(
                action=PlanAction.SPEAK,
                response_mode=ResponseMode.INSTANT,
                instant_text=(
                    "I'm having trouble understanding. "
                    "Are you looking for a book, checking an order, or need a payment link?"
                ),
                reason="no_openai",
            )

        return await self._llm_plan(state, user_text)

    async def _llm_plan(self, state: V2SessionState, user_text: str) -> Plan:
        snapshot = state.snapshot()
        messages = [
            {"role": "system", "content": _PLANNER_SYSTEM},
            {
                "role": "user",
                "content": json.dumps(
                    {"state": snapshot, "user_text": user_text},
                    ensure_ascii=False,
                ),
            },
        ]
        try:
            resp = await self._get_client().chat.completions.create(
                model=self._model(),
                messages=messages,
                temperature=0.2,
                max_tokens=300,
                response_format={"type": "json_object"},
            )
            raw = (resp.choices[0].message.content or "{}").strip()
            data = json.loads(raw)
        except Exception as exc:
            logger.warning("v2_planner_llm_failed sid=%s err=%s", state.call_sid[:6], type(exc).__name__)
            return Plan(
                action=PlanAction.SPEAK,
                response_mode=ResponseMode.LLM,
                reason="planner_llm_failed",
            )

        return self._parse_llm_plan(data)

    def _parse_llm_plan(self, data: dict[str, Any]) -> Plan:
        action_raw = str(data.get("action", "speak")).lower()
        action_map = {
            "speak": PlanAction.SPEAK,
            "tool": PlanAction.TOOL,
            "end_call": PlanAction.END_CALL,
        }
        action = action_map.get(action_raw, PlanAction.SPEAK)

        mode_raw = str(data.get("response_mode", "llm")).lower()
        mode_map = {
            "instant": ResponseMode.INSTANT,
            "tool_result": ResponseMode.TOOL_RESULT,
            "llm": ResponseMode.LLM,
        }
        response_mode = mode_map.get(mode_raw, ResponseMode.LLM)

        patches: dict[str, Any] = {}
        stage = str(data.get("stage_hint", "") or "").strip()

        return Plan(
            action=action,
            tool=str(data.get("tool", "") or ""),
            args=dict(data.get("args") or {}),
            response_mode=response_mode,
            instant_text=str(data.get("instant_text", "") or ""),
            stage_hint=stage,
            reason=str(data.get("reason", "llm_plan")),
            state_patches=patches,
        )

    def plan_tool_followup(
        self,
        state: V2SessionState,
        last_result: "ToolExecutionResult",
        user_text: str,
    ) -> Optional[Plan]:
        """Deterministic follow-up tool plan from last result — no LLM, no state mutation."""
        if not last_result.ok:
            return None

        tool = last_result.tool
        data = last_result.data

        if tool in ("search_product_by_isbn", "catalog_search", "search_products"):
            product = data.get("product") or {}
            if not product and data.get("results"):
                results = data.get("results") or []
                product = results[0] if results else {}
            variant_id = product.get("variant_id", "")
            if variant_id:
                return Plan(
                    action=PlanAction.TOOL,
                    tool="add_to_cart",
                    args={
                        "variant_id": variant_id,
                        "title": product.get("title", ""),
                        "isbn": product.get("isbn", ""),
                        "quantity": 1,
                    },
                    response_mode=ResponseMode.TOOL_RESULT,
                    reason="followup_add_to_cart",
                    stage_hint=ConversationStage.CART_REVIEW.value,
                )
            return None

        if tool == "add_to_cart" and data.get("success"):
            return None

        return None
