"""Supervisor agent — intent, risk, tool/planner routing (structured JSON)."""
from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Optional

from .intent_router import classify_intent_heuristic, is_fast_path_supervisor_result
from .model_router import select_model
from .types import SupervisorResult, VALID_INTENTS

if TYPE_CHECKING:
    from ..config import Settings
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_SUPERVISOR_SYSTEM = """You are a voice-call supervisor for SureShot Books.
Return ONLY valid JSON matching this schema:
{
  "intent": "product_search|cart_update|checkout_payment|order_status|refund_status|facility_question|shipping_question|faq|identity_email_collection|smalltalk|escalation|unknown",
  "confidence": 0.0-1.0,
  "needs_tools": true/false,
  "needs_planner": true/false,
  "risk_level": "low|medium|high",
  "clarifying_question": null or string,
  "allowed_tool_categories": [],
  "reason": "short internal reason"
}
Never plan payment without confirmed email/cart. Never expose unverified order details.
"""


async def run_supervisor(
    session: "SessionState",
    user_text: str,
    *,
    memory_summary: str = "",
    turn_mode: str = "",
    settings: Optional["Settings"] = None,
    use_llm: bool = True,
) -> SupervisorResult:
    """
    Classify the caller turn.

    Uses fast heuristics first; optionally refines with a fast LLM when configured.
    """
    from ..config import get_settings

    s = settings or get_settings()
    heuristic = classify_intent_heuristic(user_text, session, turn_mode=turn_mode)

    if not use_llm or not getattr(s, "OPENAI_API_KEY", ""):
        logger.info(
            "supervisor_heuristic sid=%s intent=%s confidence=%.2f",
            (session.call_sid or "")[:6],
            heuristic.intent,
            heuristic.confidence,
        )
        return heuristic

    if is_fast_path_supervisor_result(heuristic):
        logger.info(
            "supervisor_fast_path sid=%s intent=%s confidence=%.2f reason=%s",
            (session.call_sid or "")[:6],
            heuristic.intent,
            heuristic.confidence,
            heuristic.reason,
        )
        return heuristic

    if heuristic.confidence >= 0.92 and not heuristic.clarifying_question:
        logger.info(
            "supervisor_heuristic_skip_llm sid=%s intent=%s confidence=%.2f",
            (session.call_sid or "")[:6],
            heuristic.intent,
            heuristic.confidence,
        )
        return heuristic

    try:
        llm_result = await _supervisor_llm(
            session,
            user_text,
            memory_summary=memory_summary,
            turn_mode=turn_mode,
            settings=s,
            heuristic=heuristic,
        )
        if llm_result.intent in VALID_INTENTS:
            return llm_result
    except Exception as exc:
        logger.warning(
            "supervisor_llm_failed sid=%s err=%s fallback=heuristic",
            (session.call_sid or "")[:6],
            type(exc).__name__,
        )

    return heuristic


async def _supervisor_llm(
    session: "SessionState",
    user_text: str,
    *,
    memory_summary: str,
    turn_mode: str,
    settings: "Settings",
    heuristic: SupervisorResult,
) -> SupervisorResult:
    from openai import AsyncOpenAI
    from ..reliability.openai_retry import call_with_retry

    model = select_model("supervisor", heuristic, settings=settings)
    client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY, timeout=settings.VOICE_OPENAI_TIMEOUT_MS / 1000)

    user_payload = {
        "utterance": user_text,
        "turn_mode": turn_mode,
        "memory_summary": memory_summary,
        "heuristic_hint": heuristic.to_dict(),
        "payment_flow_status": getattr(session, "payment_flow_status", ""),
        "payment_email_confirmed": getattr(session, "payment_email_confirmed", False),
        "payment_cart_confirmed": getattr(session, "payment_cart_confirmed", False),
    }

    async def _call():
        return await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": _SUPERVISOR_SYSTEM},
                {"role": "user", "content": json.dumps(user_payload)},
            ],
            temperature=0.0,
            max_tokens=300,
            response_format={"type": "json_object"},
        )

    resp = await call_with_retry(_call, purpose="supervisor", max_attempts=2)
    raw = (resp.choices[0].message.content or "").strip()
    data = json.loads(raw)
    result = SupervisorResult.from_dict(data)

    if result.risk_level == "high" and heuristic.clarifying_question and not result.clarifying_question:
        result.clarifying_question = heuristic.clarifying_question
        result.needs_tools = False

    logger.info(
        "supervisor_llm sid=%s intent=%s model=%s",
        (session.call_sid or "")[:6],
        result.intent,
        model,
    )
    return result
