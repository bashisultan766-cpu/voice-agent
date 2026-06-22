"""
EricDialogueBrain — LLM-first dialogue planner (v4.9).

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
from .eric_policy import build_brain_policy_summary, get_small_talk_response
from .schema import BrainDecision, parse_brain_json

if TYPE_CHECKING:
    from ..pipeline.router import IntentResult
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_HOW_ARE_YOU = re.compile(
    r"\b(how are you|how.?s it going|how you doing|how do you do)\b",
    re.IGNORECASE,
)
_NAME_Q = re.compile(
    r"\b(what(?:'s| is) your name|who am i (?:speaking|talking) (?:to|with)|"
    r"may i (?:have|get) your name|your name please)\b",
    re.IGNORECASE,
)
_ORIGIN_Q = re.compile(
    r"\b(where are you from|what company|who do you work for|"
    r"what store is this|where is this|sureshot)\b",
    re.IGNORECASE,
)
_KEEPALIVE = re.compile(
    r"^\s*(hello\??|are you (?:there|with me)\??|you there\??|can you hear me)\s*\.?\s*$",
    re.IGNORECASE,
)
_PAYMENT_PHRASES = re.compile(
    r"\b(send (?:me )?(?:the )?(?:bill|payment|checkout|link)|"
    r"payment (?:link|thing)|checkout|send it|send both|send those|"
    r"yes,? send it|bill book payment)\b",
    re.IGNORECASE,
)
_FRUSTRATION = re.compile(
    r"\b(damn|hell|stupid|ridiculous|frustrated|angry|useless|"
    r"not working|what(?:'s| is) wrong)\b",
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

    if _ORIGIN_Q.search(t) and not _NAME_Q.search(t):
        return BrainDecision(
            intent="store_info_question",
            confidence=0.94,
            response_style="domain_answer",
            source="fast_path",
        )

    if _KEEPALIVE.match(t):
        if active and active not in ("idle", "greeting", ""):
            return BrainDecision(
                intent="keepalive_question",
                confidence=0.93,
                response_style="short",
                source="fast_path",
            )
        if "hello" in t.lower() and "how are you" in t.lower():
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

    # Greeting with small talk compound
    if input_intent == "greeting" and _HOW_ARE_YOU.search(t):
        return BrainDecision(
            intent="small_talk",
            confidence=0.94,
            source="fast_path",
        )

    return None


def _build_brain_prompt(
    caller_text: str,
    input_intent: str,
    session: "SessionState",
) -> str:
    from ..dialogue.manager import DialogueManager
    from ..cart.session import get_ledger

    state = DialogueManager.get_state(session)
    ledger = get_ledger(session)
    memory_block = build_brain_context(session)

    lines = [
        "You are Eric's dialogue brain for SureShot Books phone support.",
        "Return JSON only. No tools. No markdown.",
        "",
        build_brain_policy_summary(),
        "",
        f"Customer turn: {caller_text[:300]}",
        f"Router intent (hint): {input_intent}",
        f"Active flow: {state.active_flow or 'idle'}",
        f"Expected next: {state.expected_next or 'none'}",
        f"Cart confirmed: {ledger.confirmed_count()}",
        f"Payment status: {getattr(session, 'payment_flow_status', 'idle')}",
        f"Email pending: {bool(getattr(session, 'pending_email', ''))}",
        f"Email confirmed: {bool(getattr(session, 'confirmed_email', ''))}",
        f"Resumed call: {getattr(session, 'is_resumed_call', False)}",
        f"Resume delivered: {getattr(session, 'resume_greeting_delivered', False)}",
        f"ISBN buffer: {getattr(session, 'isbn_buffer', '')[:20]}",
    ]
    if memory_block:
        lines.append(memory_block)
    lines.append(
        'JSON schema: {"intent":"...","confidence":0.0,"customer_mood":"normal",'
        '"task_required":true,"worker_plan":[],"response_style":"short",'
        '"response_goal":"","ask_one_question":"","should_hold_for_more_speech":false}'
    )
    return "\n".join(lines)


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
            prompt = _build_brain_prompt(caller_text, input_intent, session)
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
            intent=input_intent,
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
    return get_small_talk_response(decision.intent, session)


_brain: Optional[EricDialogueBrain] = None


def get_dialogue_brain(settings=None) -> EricDialogueBrain:
    global _brain
    if _brain is None:
        _brain = EricDialogueBrain(settings=settings)
    return _brain
