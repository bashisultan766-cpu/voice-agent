"""
Final LLM Composer — the only natural speaker (v4.11).

Deterministic templates first; LLM streaming delegated to MainLLMComposer.
No direct openai import in this module.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Optional

from .eric_master_policy import (
    block_processing_fee,
    build_eric_final_response_system_prompt,
    get_deterministic_template,
    sanitize_policy_leak,
)
from .fact_packet import FactPacket
from .memory_packet import MemoryPacket
from .types import SupervisorDecision

if TYPE_CHECKING:
    from ..composer.main_llm_composer import MainLLMComposer
    from ..pipeline.router import IntentResult
    from ..state.models import SessionState
    from ..workers.base import WorkerBundle

logger = logging.getLogger(__name__)


def _deterministic_response(
    session: "SessionState",
    decision: SupervisorDecision,
    intent_result: "IntentResult",
    fact_packet: FactPacket,
) -> Optional[str]:
    """Exact templates for business-critical cases."""
    from ..brain.eric_policy import get_small_talk_response, get_response_template

    intent = intent_result.intent

    if decision.user_intent == "out_of_domain":
        if "sport" in (intent_result.entities.get("product_phrase") or "").lower():
            return get_deterministic_template("sports_redirect")
        return get_deterministic_template("out_of_domain")

    pfr = getattr(session, "payment_flow_result", {}) or {}
    if pfr.get("safe_message") and pfr.get("ran"):
        return str(pfr["safe_message"]).strip()

    if pfr.get("email_sent"):
        return get_deterministic_template("payment_sent")

    if intent == "address_update":
        return get_deterministic_template("address_update")

    plan = getattr(session, "response_plan", {}) or {}
    say = (plan.get("say") or "").strip()
    action = plan.get("action", "")

    if action == "subtotal" and say:
        return say
    if "subtotal" in say.lower() and "shipping" in say.lower():
        return say

    if intent in (
        "small_talk", "identity_question", "agent_name_question",
        "company_origin_question", "company_question", "job_question",
        "what_do_you_do", "keepalive_question", "small_talk_keepalive",
        "frustration_repair", "out_of_domain_question", "vague_book_request",
        "greeting",
    ):
        text = get_small_talk_response(intent, session)
        if text:
            return text

    if intent == "email_provided":
        conf = getattr(session, "email_confidence", "medium") or "medium"
        if conf == "low":
            return "I may have heard that wrong. Please spell the email slowly."
        from ..pipeline.email_speller import build_email_readback
        email = getattr(session, "pending_email", "") or intent_result.entities.get("email", "")
        raw = intent_result.entities.get("email_raw", "") or email
        if email:
            return build_email_readback(email, raw)

    if intent == "email_confirmation":
        from ..pipeline.email_speller import build_email_spell_only
        email = getattr(session, "confirmed_email", "") or getattr(session, "pending_email", "")
        if email:
            return build_email_spell_only(email)

    if decision.one_question_to_ask and decision.response_strategy == "ask_one_question":
        return decision.one_question_to_ask

    if say and action in (
        "payment_sent", "payment_blocked", "clarify_vague_book",
        "out_of_domain", "facility_unknown", "backorder", "address_update",
    ):
        return say

    if fact_packet.safe_response_hints:
        return fact_packet.safe_response_hints[0]

    return None


class FinalResponseComposer:
    """Compose final natural Eric response from approved facts."""

    def __init__(self, settings=None, composer: Optional["MainLLMComposer"] = None):
        from ..config import get_settings
        from ..composer.main_llm_composer import get_composer
        self._settings = settings or get_settings()
        self._composer = composer or get_composer()

    async def compose(
        self,
        session: "SessionState",
        caller_text: str,
        decision: SupervisorDecision,
        intent_result: "IntentResult",
        memory: MemoryPacket,
        fact_packet: FactPacket,
        worker_bundle: "WorkerBundle",
        caller_context=None,
    ) -> tuple[str, str]:
        """Returns (response_text, source) where source is 'deterministic' or 'llm'."""
        sid = session.call_sid[:6]

        det = _deterministic_response(session, decision, intent_result, fact_packet)
        if det:
            text = block_processing_fee(det)
            text, _ = sanitize_policy_leak(text)
            logger.info(
                "eric_final_response sid=%s intent=%s source=deterministic",
                sid, decision.user_intent,
            )
            return text, "deterministic"

        if not decision.should_answer_now:
            return "", "hold"

        session.last_supervisor_decision = decision
        session.last_eric_memory_context = memory.to_composer_context()
        session.last_eric_fact_context = fact_packet.to_composer_context()

        tokens: list[str] = []
        try:
            async for event in self._composer.stream_response(
                session,
                caller_text,
                intent_result,
                worker_bundle,
                caller_context,
                self._settings,
            ):
                if event.get("type") == "text_token":
                    tok = event.get("token", "")
                    if tok:
                        tokens.append(tok)
            text = "".join(tokens).strip()
            source = "llm" if text else "deterministic"
        except Exception:
            logger.exception("final_composer_delegate_error sid=%s", sid)
            from ..pipeline.response_guard import apply_response_guard
            text = apply_response_guard(
                "",
                intent_result.intent,
                call_sid=session.call_sid,
                response_plan=getattr(session, "response_plan", None),
            ) or "How can I help you with SureShot Books?"
            source = "deterministic"

        if not text:
            from ..pipeline.response_guard import apply_response_guard
            text = apply_response_guard(
                "",
                intent_result.intent,
                call_sid=session.call_sid,
                response_plan=getattr(session, "response_plan", None),
            ) or ""

        text = block_processing_fee(text)
        text, _ = sanitize_policy_leak(text)
        logger.info(
            "eric_final_response sid=%s intent=%s source=%s",
            sid, decision.user_intent, source,
        )
        return text, source


_composer: FinalResponseComposer | None = None


def get_final_composer(settings=None, composer=None) -> FinalResponseComposer:
    global _composer
    if _composer is None or composer is not None:
        _composer = FinalResponseComposer(settings=settings, composer=composer)
    return _composer
