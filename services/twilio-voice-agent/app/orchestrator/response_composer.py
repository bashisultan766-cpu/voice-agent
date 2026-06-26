"""Response composer — natural phone speech from tool results."""
from __future__ import annotations

import json
import logging
import re
from typing import TYPE_CHECKING, Optional

from .intent_router import resolve_smalltalk_response
from .model_router import select_model
from .types import OrchestratorTurnContext, SupervisorResult, ToolExecutionResult

if TYPE_CHECKING:
    from ..config import Settings
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_COMPOSER_SYSTEM = """You compose short spoken responses for a phone agent at SureShot Books.
Rules:
- Plain speech only. No markdown, JSON, bullets, or URLs.
- One question at a time.
- Never invent product, order, refund, or payment facts — use tool results only.
- Keep under 50 words when possible.
"""


def should_skip_composer_llm(
    ctx: OrchestratorTurnContext,
    session: Optional["SessionState"] = None,
) -> bool:
    """True when a safe deterministic spoken response is available."""
    supervisor = ctx.supervisor or SupervisorResult()
    if supervisor.clarifying_question:
        return True
    if ctx.planner and ctx.planner.blocked and ctx.planner.customer_message:
        return True
    from ..agent_runtime.payment_flow_state import spoken_email_confirmation

    if session and spoken_email_confirmation(session):
        return True
    for result in reversed(ctx.tool_results):
        if result.success:
            if result.result.get("customer_message") or result.result.get("suggested_response"):
                return True
            if result.result.get("message") and result.result.get("escalation_required"):
                return True
    if _deterministic_from_tools(ctx.tool_results, supervisor, session):
        return True
    if supervisor.intent == "smalltalk":
        return True
    return False


async def compose_response(
    session: "SessionState",
    ctx: OrchestratorTurnContext,
    *,
    settings: Optional["Settings"] = None,
    use_llm: bool = True,
) -> str:
    """Return customer-facing spoken text."""
    supervisor = ctx.supervisor or SupervisorResult()

    if supervisor.clarifying_question:
        return _phone_safe(supervisor.clarifying_question)

    if ctx.planner and ctx.planner.blocked and ctx.planner.customer_message:
        return _phone_safe(ctx.planner.customer_message)

    # Deterministic payment/email FSM messages take precedence.
    from ..agent_runtime.payment_flow_state import spoken_email_confirmation

    confirm = spoken_email_confirmation(session)
    if confirm:
        return _phone_safe(confirm)

    for result in reversed(ctx.tool_results):
        suggested = result.result.get("suggested_response")
        if suggested and result.success:
            return _phone_safe(str(suggested))
        msg = result.result.get("customer_message") or result.result.get("message")
        if msg and result.success:
            return _phone_safe(str(msg))

    deterministic = _deterministic_from_tools(ctx.tool_results, supervisor, session)
    if deterministic:
        return _phone_safe(deterministic)

    if supervisor.intent == "smalltalk":
        if supervisor.clarifying_question and supervisor.reason == "yes_no_reply":
            return _phone_safe(supervisor.clarifying_question)
        return _phone_safe(resolve_smalltalk_response(ctx.user_text or ""))

    if not ctx.tool_results:
        return _phone_safe("How can I help you next?")

    if not use_llm or should_skip_composer_llm(ctx, session):
        return _phone_safe(_fallback_summary(ctx.tool_results))

    from ..config import get_settings

    s = settings or get_settings()
    if not getattr(s, "OPENAI_API_KEY", ""):
        return _phone_safe(_fallback_summary(ctx.tool_results))

    try:
        return _phone_safe(
            await _compose_llm(session, ctx, settings=s),
        )
    except Exception as exc:
        logger.warning(
            "composer_llm_failed sid=%s err=%s",
            (session.call_sid or "")[:6],
            type(exc).__name__,
        )
        return _phone_safe(_fallback_summary(ctx.tool_results))


def _deterministic_from_tools(
    results: list[ToolExecutionResult],
    supervisor: SupervisorResult,
    session: Optional["SessionState"] = None,
) -> str:
    from ..agent_runtime.not_found_escalation_flow import is_search_not_found

    for result in results:
        if result.tool == "create_product_not_found_escalation" and result.success:
            return str(
                result.result.get("customer_message")
                or (
                    "That item is not showing as available right now. "
                    "I'll forward this to our team. If we can source it, they'll contact you by email."
                )
            )
        if result.tool in (
            "search_facility_policy",
            "check_facility_content_allowed",
            "explain_facility_restriction",
            "explain_facility_delivery_rejection",
            "answer_facility_policy_question",
            "fetch_facility_policy_analysis",
            "facility_policy_lookup",
            "lookup_order_status",
            "lookup_refund_status",
            "faq_lookup",
            "shipping_policy_lookup",
            "get_cart",
        ):
            if result.result.get("customer_message"):
                return str(result.result["customer_message"])
            if result.result.get("message"):
                return str(result.result["message"])
            if result.result.get("escalation_required"):
                return str(
                    result.result.get("message")
                    or "I don't have enough facility policy detail to answer confidently. "
                    "I can forward this to our team."
                )

    for result in results:
        if result.blocked_by_guard:
            return str(
                result.result.get("customer_message")
                or result.result.get("error")
                or "I need a bit more information before I can do that."
            )
        if supervisor.intent == "product_search" and result.tool == "search_products":
            if is_search_not_found(result.result):
                if session and getattr(session, "awaiting_not_found_escalation_email", False):
                    return (
                        "That item is not showing as available right now. "
                        "I can forward this to our team to check manually. "
                        "What email should they use to contact you?"
                    )
                for esc in results:
                    if esc.tool == "create_product_not_found_escalation" and esc.success:
                        return str(esc.result.get("customer_message") or "")
                return (
                    "That item is not showing as available right now. "
                    "I can forward this to our team to check manually. "
                    "What email should they use to contact you?"
                )
            products = result.result.get("products") or result.result.get("results") or []
            if isinstance(products, list) and products:
                first = products[0]
                title = first.get("title") or first.get("name") or "that book"
                price = first.get("price") or ""
                if price:
                    return f"I found {title} for {price}. Would you like to add it to your cart?"
                return f"I found {title}. Would you like to add it to your cart?"
    return ""


def _fallback_summary(results: list[ToolExecutionResult]) -> str:
    if not results:
        return "How can I help you next?"
    if all(r.success for r in results):
        return "I've got that information. What would you like to do next?"
    return "I ran into a small issue pulling that up. Could you try once more?"


async def _compose_llm(
    session: "SessionState",
    ctx: OrchestratorTurnContext,
    *,
    settings: "Settings",
) -> str:
    from openai import AsyncOpenAI
    from ..reliability.openai_retry import call_with_retry

    model = select_model("composer", ctx.supervisor, settings=settings)
    client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY, timeout=settings.VOICE_OPENAI_TIMEOUT_MS / 1000)

    tool_payload = [
        {"tool": r.tool, "success": r.success, "result": r.result}
        for r in ctx.tool_results
    ]
    user_content = json.dumps({
        "caller_said": ctx.user_text,
        "supervisor": (ctx.supervisor or SupervisorResult()).to_dict(),
        "tool_results": tool_payload,
        "memory_summary": ctx.memory_summary,
    })

    async def _call():
        return await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": _COMPOSER_SYSTEM},
                {"role": "user", "content": user_content},
            ],
            temperature=0.5,
            max_tokens=200,
        )

    resp = await call_with_retry(_call, purpose="composer", max_attempts=2)
    return (resp.choices[0].message.content or "").strip()


def _phone_safe(text: str) -> str:
    from ..agent_runtime.output_guardrails import apply_output_guardrails

    cleaned = (text or "").strip()
    cleaned = re.sub(r"https?://\S+", "the link I emailed you", cleaned, flags=re.I)
    cleaned = re.sub(r"[*_#`]", "", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned)
    return apply_output_guardrails(cleaned).text
