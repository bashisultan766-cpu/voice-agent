"""
EricDialogueBrain — LLM-first dialogue planner (v4.10).

JSON-only OpenAI planner that runs BEFORE final intent selection.
Falls back to v4.8 deterministic router on timeout or failure.
Never uses tools= or role=tool.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import TYPE_CHECKING, Any, Optional

from openai import AsyncOpenAI

from ..config import get_settings
from ..conversation.call_memory import build_brain_context, record_brain_fact
from ..catalog.query_specificity import is_generic_product_query
from .eric_prompt_compiler import compile_brain_user_prompt
from .schema import BrainDecision, parse_brain_json

if TYPE_CHECKING:
    from ..pipeline.router import IntentResult
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_HOW_ARE_YOU = re.compile(
    r"\b(how are you|how.?s it going|how you doing|how do you do|how are you doing)\b",
    re.IGNORECASE,
)
_NAME_Q = re.compile(
    r"\b("
    r"what(?:'s| is) your name|what(?:'s| is) (?:the )?name|"
    r"who am i (?:speaking|talking) (?:to|with)|"
    r"who are you|"
    r"is your name|"
    r"may i (?:have|get) your name|your name please|"
    r"(?:tell me|what(?:'s| is)) (?:your )?name"
    r")\b",
    re.IGNORECASE,
)
_JOB_Q = re.compile(
    r"\b("
    r"what(?:'s| is) your job|what do you do|what can you do|"
    r"what are you|what is your role|what do you do for work"
    r")\b",
    re.IGNORECASE,
)
_ORIGIN_Q = re.compile(
    r"\b("
    r"where are you from|what company|who do you work for|"
    r"what store is this|where is this|what company is this|sureshot"
    r")\b",
    re.IGNORECASE,
)
_KEEPALIVE = re.compile(
    r"^\s*(hello\??|are you (?:there|with me)\??|you there\??|can you hear me)\s*\.?\s*$",
    re.IGNORECASE,
)
_GREETING = re.compile(
    r"^\s*(hi|hello|hey|good morning|good afternoon|good evening)\s*[.!?]?\s*$",
    re.IGNORECASE,
)
_GENERIC_BOOK = re.compile(
    r"\b("
    r"i need (?:a |the )?books?|i want (?:a |the )?books?|"
    r"help me find (?:a )?books?|do you sell books?|"
    r"can you (?:give|get|find) me (?:a )?books?"
    r")\b",
    re.IGNORECASE,
)
_PAYMENT_PHRASES = re.compile(
    r"\b("
    r"send (?:me )?(?:the )?(?:bill|payment|checkout|link)|"
    r"payment (?:link|thing)|checkout|send it|send both|send those|"
    r"yes,? send it|bill book payment"
    r")\b",
    re.IGNORECASE,
)
_THANKS = re.compile(
    r"^\s*(?:okay|ok)?\s*(?:thank you|thanks|thank you so much|thanks a lot)\s*[.!?]?\s*$",
    re.IGNORECASE,
)
_FRUSTRATION = re.compile(
    r"\b(damn|hell|stupid|ridiculous|frustrated|angry|useless|"
    r"not working|what(?:'s| is) wrong)\b",
    re.IGNORECASE,
)
_OUT_OF_DOMAIN = re.compile(
    r"\b("
    r"who is (?:donald )?trump|where is (?:donald )?trump|"
    r"who won (?:the )?game|sports news|what(?:'s| is) the weather|"
    r"who is the president|tell me (?:about )?(?:politics|sports)"
    r")\b",
    re.IGNORECASE,
)
_TOPIC_BOOK_SEARCH = re.compile(
    r"\b("
    r"(?:search|find|do you have|got any|looking for) (?:books? about|books on)|"
    r"books about .+|books on .+"
    r")\b",
    re.IGNORECASE,
)


def _fast_path_decision(
    caller_text: str,
    input_intent: str,
    session: "SessionState",
) -> Optional[BrainDecision]:
    """Deterministic fast paths — no LLM needed."""
    t = (caller_text or "").strip()
    if not t:
        return None

    from ..dialogue.manager import DialogueManager
    state = DialogueManager.get_state(session)
    active = state.active_flow or ""
    pfs = getattr(session, "payment_flow_status", "idle") or "idle"

    if _THANKS.match(t):
        return BrainDecision(
            intent="ending_thanks",
            confidence=0.94,
            response_style="closing",
            source="fast_path",
        )

    if _HOW_ARE_YOU.search(t):
        return BrainDecision(
            intent="small_talk",
            confidence=0.95,
            response_style="short",
            response_goal="answer how are you naturally",
            source="fast_path",
        )

    if _NAME_Q.search(t):
        return BrainDecision(
            intent="identity_question",
            confidence=0.96,
            response_style="domain_answer",
            source="fast_path",
        )

    if _JOB_Q.search(t) and not _NAME_Q.search(t):
        return BrainDecision(
            intent="job_question",
            confidence=0.95,
            response_style="domain_answer",
            source="fast_path",
        )

    if _ORIGIN_Q.search(t) and not _NAME_Q.search(t):
        return BrainDecision(
            intent="company_origin_question",
            confidence=0.94,
            response_style="domain_answer",
            source="fast_path",
        )

    if _KEEPALIVE.match(t) or (_GREETING.match(t) and t.lower().strip("?.!") == "hello"):
        if active and active not in ("idle", "greeting", ""):
            return BrainDecision(
                intent="keepalive_question",
                confidence=0.93,
                response_style="short",
                source="fast_path",
            )
        if "hello" in t.lower() and _HOW_ARE_YOU.search(t):
            return BrainDecision(
                intent="small_talk",
                confidence=0.92,
                source="fast_path",
            )
        return BrainDecision(
            intent="keepalive_question",
            confidence=0.90,
            response_style="short",
            source="fast_path",
        )

    if _TOPIC_BOOK_SEARCH.search(t):
        return BrainDecision(
            intent="topic_book_search_offer",
            confidence=0.91,
            task_required=True,
            worker_plan=["product_search"],
            response_style="short",
            source="fast_path",
        )

    if _OUT_OF_DOMAIN.search(t) and not _TOPIC_BOOK_SEARCH.search(t):
        return BrainDecision(
            intent="out_of_domain_question",
            confidence=0.92,
            response_style="domain_answer",
            source="fast_path",
        )

    if _GENERIC_BOOK.search(t) or (
        input_intent in ("vague_book_request", "book_title_search", "product_search")
        and is_generic_product_query(t)
    ):
        return BrainDecision(
            intent="vague_book_request",
            confidence=0.93,
            response_style="short",
            source="fast_path",
        )

    if _FRUSTRATION.search(t):
        return BrainDecision(
            intent="frustration_repair",
            confidence=0.91,
            customer_mood="frustrated",
            response_style="repair",
            source="fast_path",
        )

    if _PAYMENT_PHRASES.search(t):
        intent = "payment_execute" if pfs == "awaiting_send_confirmation" else "send_payment_link"
        return BrainDecision(
            intent=intent,
            confidence=0.93,
            task_required=True,
            worker_plan=["cart_memory", "payment_flow"],
            response_style="payment",
            source="fast_path",
        )

    if input_intent == "greeting" and _HOW_ARE_YOU.search(t):
        return BrainDecision(
            intent="small_talk",
            confidence=0.94,
            source="fast_path",
        )

    return None


async def _call_llm_brain(
    prompt: str,
    settings,
) -> Optional[dict]:
    client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
    timeout = settings.VOICE_LLM_BRAIN_TIMEOUT_MS / 1000
    model = settings.VOICE_LLM_BRAIN_MODEL

    for attempt in range(settings.VOICE_LLM_BRAIN_MAX_RETRIES + 1):
        try:
            resp = await asyncio.wait_for(
                client.chat.completions.create(
                    model=model,
                    messages=[
                        {
                            "role": "system",
                            "content": (
                                "You are a JSON dialogue planner. "
                                "Respond with valid JSON only. No tools."
                            ),
                        },
                        {"role": "user", "content": prompt},
                    ],
                    response_format={"type": "json_object"},
                    temperature=0.2,
                    max_tokens=300,
                ),
                timeout=timeout,
            )
            raw = resp.choices[0].message.content or "{}"
            return json.loads(raw)
        except asyncio.TimeoutError:
            if attempt >= settings.VOICE_LLM_BRAIN_MAX_RETRIES:
                raise
        except json.JSONDecodeError:
            if attempt >= settings.VOICE_LLM_BRAIN_MAX_RETRIES:
                return None
        except Exception:
            if attempt >= settings.VOICE_LLM_BRAIN_MAX_RETRIES:
                raise
    return None


class EricDialogueBrain:
    """OpenAI JSON planner with deterministic fast paths and router fallback."""

    def __init__(self, settings=None):
        self._settings = settings or get_settings()

    async def plan(
        self,
        session: "SessionState",
        caller_text: str,
        input_intent: str,
        *,
        short_resolved_intent: str = "",
    ) -> BrainDecision:
        settings = self._settings
        sid = session.call_sid[:6]

        if short_resolved_intent:
            decision = BrainDecision(
                intent=short_resolved_intent,
                confidence=0.93,
                source="short_resolver",
            )
            logger.info(
                "llm_brain_decision sid=%s input_intent=%s final_intent=%s "
                "confidence=%.2f mood=%s worker_plan=%s source=short_resolver",
                sid, input_intent, decision.intent,
                decision.confidence, decision.customer_mood, decision.worker_plan,
            )
            return decision

        fast = _fast_path_decision(caller_text, input_intent, session)
        if fast:
            logger.info(
                "llm_brain_decision sid=%s input_intent=%s final_intent=%s "
                "confidence=%.2f mood=%s worker_plan=%s source=fast_path",
                sid, input_intent, fast.intent,
                fast.confidence, fast.customer_mood, fast.worker_plan,
            )
            record_brain_fact(session, fast.intent)
            return fast

        if not settings.VOICE_LLM_BRAIN_ENABLED:
            return BrainDecision(
                intent=input_intent,
                confidence=0.80,
                source="router",
            )

        try:
            prompt = compile_brain_user_prompt(caller_text, input_intent, session)
            raw = await _call_llm_brain(prompt, settings)
            if raw:
                decision = parse_brain_json(raw)
                if decision.intent == "unknown" and input_intent != "unknown":
                    decision.intent = input_intent
                    decision.confidence = max(decision.confidence, 0.75)
                    decision.source = "llm_with_router_hint"
                logger.info(
                    "llm_brain_decision sid=%s input_intent=%s final_intent=%s "
                    "confidence=%.2f mood=%s worker_plan=%s",
                    sid, input_intent, decision.intent,
                    decision.confidence, decision.customer_mood, decision.worker_plan,
                )
                record_brain_fact(session, decision.intent)
                return decision
        except asyncio.TimeoutError:
            logger.warning("llm_brain_timeout sid=%s", sid)
        except Exception:
            logger.exception("llm_brain_error sid=%s", sid)

        logger.info("llm_brain_fallback sid=%s input_intent=%s", sid, input_intent)
        return BrainDecision(
            intent=input_intent if input_intent != "unknown" else "unknown",
            confidence=0.70,
            source="fallback",
        )


def apply_brain_to_intent(
    intent_result: "IntentResult",
    decision: BrainDecision,
) -> None:
    """Mutate IntentResult in place from brain decision."""
    if decision.intent and decision.intent != intent_result.intent:
        intent_result.intent = decision.intent
    if decision.confidence > 0:
        intent_result.confidence = decision.confidence


def get_brain_response_text(decision: BrainDecision, session: "SessionState") -> Optional[str]:
    """Return deterministic response for brain-handled small talk intents."""
    from .eric_policy import get_small_talk_response
    return get_small_talk_response(decision.intent, session)


_brain: Optional[EricDialogueBrain] = None


def get_dialogue_brain(settings=None) -> EricDialogueBrain:
    global _brain
    if _brain is None:
        _brain = EricDialogueBrain(settings=settings)
    return _brain
