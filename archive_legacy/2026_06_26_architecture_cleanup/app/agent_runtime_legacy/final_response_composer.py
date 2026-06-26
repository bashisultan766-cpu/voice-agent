"""
Final LLM Composer — the only natural speaker (v4.12).

Critical business templates first; conversational turns use Final LLM (llm_first mode).
No direct openai import in this module.
"""
from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING, Optional

from .eric_master_policy import (
    block_processing_fee,
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

_EMERGENCY_FALLBACK = "I'm here. How can I help you with SureShot Books today?"

_IDENTITY_INTENTS = frozenset({
    "identity", "identity_question", "agent_name_question", "name_question",
})
_COMPANY_JOB_INTENTS = frozenset({
    "company_question", "company_origin_question", "job_question", "what_do_you_do",
    "store_info_question",
})
_CAPABILITY_COMPLAINT_PAT = re.compile(
    r"\b("
    r"not using llm|not using l and m|l and m|you're not using|you are not using|"
    r"not working good|this is not working|why are you not responding|"
    r"why are you not using|openai|gpt|llm model|11 model|one model|version \d"
    r")\b",
    re.I,
)
_MODEL_PROVIDER_PAT = re.compile(
    r"\b(why are you not using.*model|what model|openai|gpt|llm|version \d+\.\d+)\b",
    re.I,
)

_CRITICAL_PLAN_ACTIONS = frozenset({
    "payment_sent", "payment_blocked", "payment_already_sent",
    "payment_flow", "ask_send_confirmation", "confirm_email",
    "facility_unknown", "backorder", "address_update",
    "clarify_vague_book", "out_of_domain",
})

_LLM_FIRST_INTENTS = frozenset({
    "small_talk", "identity_question", "agent_name_question",
    "company_origin_question", "company_question", "job_question",
    "what_do_you_do", "keepalive_question", "small_talk_keepalive",
    "frustration_repair", "out_of_domain_question", "vague_book_request",
    "repeat_clarification", "unknown", "greeting", "store_info_question",
})

_ACTION_GATE_LLM_INTENTS = frozenset({
    "company_question", "frustration_repair", "repeat_clarification",
    "keepalive_question", "identity_question", "unknown",
})


def _is_identity_turn(intent: str, decision: SupervisorDecision, caller_text: str) -> bool:
    from .action_gate import is_name_question
    if is_name_question(caller_text):
        return True
    if intent in _IDENTITY_INTENTS:
        return True
    if decision.user_intent == "identity":
        return True
    return False


def _is_company_job_turn(intent: str, decision: SupervisorDecision, caller_text: str) -> bool:
    from .action_gate import is_name_question
    if is_name_question(caller_text):
        return False
    if intent in _COMPANY_JOB_INTENTS:
        return True
    if decision.user_intent in ("company_question", "job_question"):
        return True
    return False


def _is_capability_complaint(caller_text: str) -> bool:
    return bool(_CAPABILITY_COMPLAINT_PAT.search(caller_text or ""))


def _is_model_provider_question(caller_text: str) -> bool:
    return bool(_MODEL_PROVIDER_PAT.search(caller_text or ""))


def _conversational_deterministic_response(
    session: "SessionState",
    decision: SupervisorDecision,
    intent_result: "IntentResult",
    caller_text: str,
) -> Optional[str]:
    """Exact templates for identity, company/job, and capability complaints (v4.13.1)."""
    intent = intent_result.intent
    t = (caller_text or "").strip()

    if re.search(r"\bnot asking about your job\b", t, re.I):
        return get_deterministic_template("identity_name_clarify")

    if intent == "frustration_repair" or decision.user_intent == "frustration_repair":
        if (
            _is_model_provider_question(caller_text)
            or decision.response_strategy == "capability_boundary"
        ):
            return get_deterministic_template("capability_boundary")
        return get_deterministic_template("capability_repair")

    if _is_identity_turn(intent, decision, caller_text):
        return get_deterministic_template("identity_name")

    if _is_capability_complaint(caller_text):
        if (
            _is_model_provider_question(caller_text)
            or decision.response_strategy == "capability_boundary"
        ):
            return get_deterministic_template("capability_boundary")
        return get_deterministic_template("capability_repair")

    if _is_company_job_turn(intent, decision, caller_text):
        if intent in ("job_question", "what_do_you_do") or decision.user_intent == "job_question":
            from ..brain.eric_policy import get_small_talk_response
            return get_small_talk_response("job_question", session)
        return get_deterministic_template("company_intro")

    return None


def _is_llm_first_mode(settings) -> bool:
    return (getattr(settings, "VOICE_FINAL_RESPONSE_MODE", "llm_first") or "llm_first") == "llm_first"


def _should_use_final_llm(settings, decision: SupervisorDecision, intent: str) -> bool:
    if not _is_llm_first_mode(settings):
        return False

    if intent in (
        "email_provided", "email_confirmation", "spell_email_request",
        "payment_execute", "send_payment_link", "address_update",
    ):
        return False

    sup = decision.user_intent
    if sup in ("payment_link", "payment_execute", "address_update", "email_capture", "email_spell"):
        return False

    if intent in ("identity_question", "agent_name_question", "name_question"):
        return False
    if sup == "identity":
        return False

    if sup == "unknown" and settings.VOICE_FINAL_LLM_FOR_UNKNOWN:
        return True
    if sup == "out_of_domain" and settings.VOICE_FINAL_LLM_FOR_OUT_OF_DOMAIN:
        return True
    if sup in ("small_talk", "company_question", "greeting") and settings.VOICE_FINAL_LLM_FOR_SMALL_TALK:
        return True
    if sup in ("repeat_clarification", "vague_book_request") and settings.VOICE_FINAL_LLM_FOR_CLARIFICATION:
        return True
    if sup == "frustration_repair":
        return False

    if intent in _LLM_FIRST_INTENTS:
        if intent == "out_of_domain_question" and not settings.VOICE_FINAL_LLM_FOR_OUT_OF_DOMAIN:
            return False
        if intent == "unknown" and not settings.VOICE_FINAL_LLM_FOR_UNKNOWN:
            return False
        if intent in ("small_talk", "greeting"):
            return settings.VOICE_FINAL_LLM_FOR_SMALL_TALK
        if intent in ("vague_book_request", "repeat_clarification"):
            return settings.VOICE_FINAL_LLM_FOR_CLARIFICATION
        if intent in ("identity_question", "agent_name_question"):
            return False
        if intent == "frustration_repair":
            return False
        return True

    if intent in _ACTION_GATE_LLM_INTENTS:
        return intent not in ("identity_question",)

    return False


def _critical_deterministic_response(
    session: "SessionState",
    decision: SupervisorDecision,
    intent_result: "IntentResult",
    fact_packet: FactPacket,
) -> Optional[str]:
    """Exact templates only for business-critical cases."""
    intent = intent_result.intent

    pfr = getattr(session, "payment_flow_result", {}) or {}
    if pfr.get("safe_message") and pfr.get("ran"):
        return str(pfr["safe_message"]).strip()

    if pfr.get("email_sent"):
        return get_deterministic_template("payment_sent")

    if intent == "address_update" or decision.user_intent == "address_update":
        return get_deterministic_template("address_update")

    plan = getattr(session, "response_plan", {}) or {}
    say = (plan.get("say") or "").strip()
    action = plan.get("action", "")

    if action == "subtotal" and say:
        return say
    if say and "subtotal" in say.lower() and "shipping" in say.lower():
        return say

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

    if say and action in _CRITICAL_PLAN_ACTIONS:
        return say

    if decision.user_intent == "book_search" and "red river vengeance" in (
        (intent_result.entities.get("product_phrase") or "").lower()
    ):
        return get_deterministic_template("red_river_vengeance")

    red_river_phrase = intent_result.entities.get("product_phrase", "") or ""
    if "red river vengeance" in red_river_phrase.lower():
        return get_deterministic_template("red_river_vengeance")

    if fact_packet.safe_response_hints:
        hint = fact_packet.safe_response_hints[0]
        if hint and any(
            kw in hint.lower()
            for kw in ("payment link", "jessica", "subtotal", "not in stock", "backorder")
        ):
            return hint

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
        action_gate: dict | None = None,
    ) -> tuple[str, str]:
        """Returns (response_text, source) where source is 'deterministic', 'llm', or 'hold'."""
        sid = session.call_sid[:6]

        if not decision.should_answer_now:
            return "", "hold"

        conv = _conversational_deterministic_response(
            session, decision, intent_result, caller_text,
        )
        if conv:
            text = block_processing_fee(conv)
            text, _ = sanitize_policy_leak(text)
            logger.info(
                "eric_final_response sid=%s intent=%s source=deterministic",
                sid, decision.user_intent,
            )
            return text, "deterministic"

        det = _critical_deterministic_response(session, decision, intent_result, fact_packet)
        if det:
            text = block_processing_fee(det)
            text, _ = sanitize_policy_leak(text)
            logger.info(
                "eric_final_response sid=%s intent=%s source=deterministic",
                sid, decision.user_intent,
            )
            return text, "deterministic"

        session.last_supervisor_decision = decision
        session.last_eric_memory_context = memory.to_composer_context()
        session.last_eric_fact_context = fact_packet.to_composer_context()

        if _should_use_final_llm(self._settings, decision, intent_result.intent):
            text = await self._composer.compose_final_response(
                session,
                caller_text,
                decision,
                intent_result,
                memory,
                fact_packet,
                worker_bundle,
            )
            if text:
                text = block_processing_fee(text)
                text, _ = sanitize_policy_leak(text)
                from ..safety.response_sanitizer import sanitize_customer_response
                result = sanitize_customer_response(
                    text,
                    intent=intent_result.intent,
                    call_sid=session.call_sid,
                    payment_sent=bool(
                        (getattr(session, "payment_flow_result", {}) or {}).get("email_sent")
                    ),
                )
                text = result.text
                logger.info(
                    "eric_final_response sid=%s intent=%s source=llm",
                    sid, decision.user_intent,
                )
                return text, "llm"

            logger.info(
                "final_llm_fallback sid=%s reason=empty_response intent=%s",
                sid, decision.user_intent,
            )
            text = _EMERGENCY_FALLBACK
            text = block_processing_fee(text)
            text, _ = sanitize_policy_leak(text)
            logger.info(
                "eric_final_response sid=%s intent=%s source=deterministic",
                sid, decision.user_intent,
            )
            return text, "deterministic"

        text = await self._legacy_compose_fallback(
            session, caller_text, decision, intent_result, worker_bundle, caller_context,
        )
        source = "llm" if text and _is_llm_first_mode(self._settings) else "deterministic"
        if not text:
            logger.info(
                "final_llm_fallback sid=%s reason=all_paths_failed intent=%s",
                sid, decision.user_intent,
            )
            text = _EMERGENCY_FALLBACK
            source = "deterministic"

        text = block_processing_fee(text)
        text, _ = sanitize_policy_leak(text)
        logger.info(
            "eric_final_response sid=%s intent=%s source=%s",
            sid, decision.user_intent, source,
        )
        return text, source

    async def _legacy_compose_fallback(
        self,
        session: "SessionState",
        caller_text: str,
        decision: SupervisorDecision,
        intent_result: "IntentResult",
        worker_bundle: "WorkerBundle",
        caller_context,
    ) -> str:
        """Delegate to MainLLMComposer stream path when Final LLM unavailable."""
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
            return "".join(tokens).strip()
        except Exception:
            logger.exception("final_composer_delegate_error sid=%s", session.call_sid[:6])
            from ..pipeline.response_guard import apply_response_guard
            return apply_response_guard(
                "",
                intent_result.intent,
                call_sid=session.call_sid,
                response_plan=getattr(session, "response_plan", None),
            ) or ""


_composer: FinalResponseComposer | None = None


def get_final_composer(settings=None, composer=None) -> FinalResponseComposer:
    global _composer
    if _composer is None or composer is not None:
        _composer = FinalResponseComposer(settings=settings, composer=composer)
    return _composer


# Backwards-compatible alias for tests and patches
_deterministic_response = _critical_deterministic_response
