"""
ResponseComposer — the ONLY module that produces customer-facing text.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Optional

from .session_state import V2SessionState
from .types import ComposedResponse, Plan, ResponseMode, ToolChainResult, ToolExecutionResult

logger = logging.getLogger(__name__)

_COMPOSER_SYSTEM = """You are Eric at SureShot Books on a live phone call.
Convert the provided tool result or context into one or two short, natural sentences.
Rules:
- Never invent product, order, price, or tracking data.
- Use only facts from tool_result and session snapshot.
- No markdown, URLs, or JSON.
- Warm and concise."""


class ResponseComposer:
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
        brain = (getattr(self._settings, "VOICE_BRAIN_MODEL", "") or "").strip()
        if brain:
            return brain
        return getattr(self._settings, "OPENAI_MODEL", "gpt-4o")

    async def build(
        self,
        state: V2SessionState,
        user_text: str,
        plan: Plan,
        tool_result: Optional[ToolExecutionResult] = None,
        *,
        tool_chain: Optional[ToolChainResult] = None,
    ) -> ComposedResponse:
        if tool_result is None and tool_chain and tool_chain.results:
            tool_result = tool_chain.results[-1]
        mode = plan.response_mode

        if plan.action.value == "end_call" or mode == ResponseMode.INSTANT:
            text = (plan.instant_text or "").strip()
            if text:
                return ComposedResponse(text=text, end_call=plan.action.value == "end_call")

        if mode == ResponseMode.REPEAT_LAST:
            last = (state.last_response or "").strip()
            if last:
                return ComposedResponse(text=last)
            return ComposedResponse(
                text="Sorry — could you say that again? I want to make sure I help you correctly."
            )

        if mode == ResponseMode.INTERRUPT_ACK:
            return ComposedResponse(text=plan.instant_text or "Go ahead — I'm listening.")

        if tool_result and not tool_result.ok:
            return ComposedResponse(text=self._tool_error_message(tool_result))

        if tool_result and tool_result.ok:
            deterministic = self._deterministic_from_tool(tool_result, state, tool_chain)
            if deterministic:
                return ComposedResponse(text=deterministic)

        if tool_result:
            return await self._llm_compose(state, user_text, tool_result.data, plan)

        if getattr(self._settings, "OPENAI_API_KEY", ""):
            return await self._llm_compose(state, user_text, {}, plan)

        return ComposedResponse(
            text="I'm not sure I caught that. Could you tell me what you need help with?"
        )

    def _tool_error_message(self, result: ToolExecutionResult) -> str:
        code = result.error or result.data.get("error_code", "")
        if code == "email_not_confirmed":
            return "I need to confirm your email before I can send the payment link."
        if "order" in code:
            return "I'll need your order number to look that up."
        return "I couldn't complete that just now. Could you try once more?"

    def _deterministic_from_tool(
        self,
        result: ToolExecutionResult,
        state: V2SessionState,
        tool_chain: Optional[ToolChainResult] = None,
    ) -> str:
        if tool_chain and len(tool_chain.results) > 1:
            last = tool_chain.results[-1]
            if last.tool == "add_to_cart" and last.ok:
                add_msg = self._deterministic_from_tool(last, state, None)
                if add_msg:
                    return add_msg
        data = result.data
        tool = result.tool

        if tool == "send_payment_link" and data.get("success"):
            email = state.email.confirmed or state.email.pending
            masked = email.split("@")[0][:2] + "***@" + email.split("@")[-1] if "@" in email else "your email"
            return f"Done — I've sent the secure payment link to {masked}."

        if tool == "search_product_by_isbn":
            if data.get("found") and data.get("product"):
                p = data["product"]
                title = p.get("title", "that book")
                price = p.get("price", "")
                price_bit = f" for {price}" if price else ""
                return f"I found {title}{price_bit}. How many copies would you like?"
            return "I couldn't find that ISBN in our catalog. Do you have the title or another ISBN?"

        if tool in ("catalog_search", "search_products"):
            results = data.get("results") or []
            if not results:
                return "I couldn't find an exact match. Can you give me the ISBN or a more specific title?"
            if len(results) == 1:
                p = results[0]
                return f"I found {p.get('title', 'a match')}. Would you like to add it to your cart?"
            titles = ", ".join(r.get("title", "item") for r in results[:3])
            return f"I found a few options: {titles}. Which one did you mean?"

        if tool == "lookup_shopify_order_details":
            if data.get("order_number") or data.get("name"):
                status = data.get("fulfillment_status") or data.get("status") or "on file"
                num = data.get("order_number") or data.get("name", "")
                return f"I found order {num}. The status is {status}. What else would you like to know?"
            return "I couldn't find that order. Could you double-check the order number?"

        if tool == "get_cart":
            items = data.get("confirmed_titles") or []
            if not items:
                return "Your cart is empty right now."
            return f"Your cart has: {', '.join(items[:5])}."

        if tool == "add_to_cart" and data.get("success"):
            cart = data.get("cart") or {}
            titles = cart.get("confirmed_titles") or []
            if titles:
                return f"Added. Your cart now has {titles[0]}."
            return "I've added that to your cart."

        return ""

    async def _llm_compose(
        self,
        state: V2SessionState,
        user_text: str,
        tool_data: dict[str, Any],
        plan: Plan,
    ) -> ComposedResponse:
        payload = {
            "user_text": user_text,
            "session": state.snapshot(),
            "tool_result": tool_data,
            "plan_reason": plan.reason,
        }
        try:
            resp = await self._get_client().chat.completions.create(
                model=self._model(),
                messages=[
                    {"role": "system", "content": _COMPOSER_SYSTEM},
                    {"role": "user", "content": json.dumps(payload, ensure_ascii=False)[:12000]},
                ],
                temperature=0.55,
                max_tokens=180,
            )
            text = (resp.choices[0].message.content or "").strip()
            if text:
                return ComposedResponse(text=text, end_call=plan.action.value == "end_call")
        except Exception as exc:
            logger.warning("v2_composer_llm_failed sid=%s err=%s", state.call_sid[:6], type(exc).__name__)

        return ComposedResponse(
            text="Let me make sure I have that right — could you say a bit more about what you need?"
        )
