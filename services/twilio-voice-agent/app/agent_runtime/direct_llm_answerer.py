"""Direct LLM answer lane for conversation-only turns (v4.15.1).

Calls OpenAI with full prompt pack — no tools.
"""
from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Optional

from openai import AsyncOpenAI

from .fake_checking_guard import is_fake_checking_phrase, sanitize_fake_checking
from .prompt_loader import load_eric_system_prompt_text

if TYPE_CHECKING:
    from ..state.models import SessionState
    from .memory_packet import MemoryPacket

logger = logging.getLogger(__name__)


@dataclass
class DirectAnswerResult:
    answer: str
    intent: str
    confidence: float
    source: str = "direct_llm_answerer"


def _timeout_fallback(intent: str, *, has_cart: bool = False, user_text: str = "") -> str:
    from .fake_checking_guard import _replacement_for_context

    return _replacement_for_context(intent, user_text, has_cart=has_cart)


def _infer_intent(user_text: str) -> str:
    t = (user_text or "").strip()
    if re.search(r"\bhow are you\b", t, re.I):
        return "small_talk"
    if re.search(r"\bremember|spoke with|talked to|called before\b", t, re.I):
        return "memory_question"
    if re.search(r"\bare you there|can you hear me\b", t, re.I):
        return "presence_check"
    if re.search(r"\bwho are you\b", t, re.I):
        return "identity"
    if re.search(r"\bwhat is your job\b", t, re.I):
        return "job_question"
    if re.search(r"\bwhat can you do\b", t, re.I):
        return "capabilities"
    return "unknown"


def _build_user_prompt(
    user_text: str,
    memory_packet: Optional["MemoryPacket"] = None,
    commerce_summary: str = "",
) -> str:
    parts = [f"Customer: {user_text}"]
    if memory_packet:
        ctx = memory_packet.to_supervisor_context()
        if ctx:
            parts.append(f"Call memory:\n{ctx}")
        if getattr(memory_packet, "can_reference_prior_call", False):
            summary = getattr(memory_packet, "safe_memory_summary", "")
            if summary:
                parts.append(f"Verified prior call summary: {summary}")
    if commerce_summary:
        parts.append(f"Commerce context: {commerce_summary}")
    parts.append(
        "\nAnswer naturally as Eric in one or two short sentences. "
        "Do NOT say 'let me check' or defer to tools. No JSON."
    )
    return "\n".join(parts)


async def answer_directly(
    user_text: str,
    *,
    session: Optional["SessionState"] = None,
    memory_packet: Optional["MemoryPacket"] = None,
    commerce_summary: str = "",
    system_prompt: Optional[str] = None,
    settings=None,
    intent: str = "",
) -> DirectAnswerResult:
    """Produce a natural direct answer without tools."""
    from ..config import get_settings

    s = settings or get_settings()
    sid = getattr(session, "call_sid", "?")[:6] if session else "?"
    inferred = intent or _infer_intent(user_text)
    has_cart = "cart" in (commerce_summary or "").lower()

    logger.info("direct_llm_answer_request sid=%s intent=%s", sid, inferred)

    prompt = system_prompt or load_eric_system_prompt_text()
    agent_system = (
        f"{prompt}\n\n"
        "You are Eric on a live phone call. Answer the customer directly. "
        "Never use fake checking phrases. Never mention tools or backends."
    )
    user_prompt = _build_user_prompt(user_text, memory_packet, commerce_summary)

    model = s.VOICE_SUPERVISOR_MODEL
    timeout = s.VOICE_MAIN_LLM_TIMEOUT_MS / 1000

    answer = ""
    confidence = 0.85

    try:
        client = AsyncOpenAI(api_key=s.OPENAI_API_KEY)
        resp = await asyncio.wait_for(
            client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": agent_system},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=0.3,
                max_tokens=200,
            ),
            timeout=timeout,
        )
        answer = (resp.choices[0].message.content or "").strip()
    except asyncio.TimeoutError:
        logger.warning("direct_llm_answer_timeout sid=%s intent=%s", sid, inferred)
        answer = _timeout_fallback(inferred, has_cart=has_cart, user_text=user_text)
        confidence = 0.5
    except Exception:
        logger.exception("direct_llm_answer_error sid=%s", sid)
        answer = _timeout_fallback(inferred, has_cart=has_cart, user_text=user_text)
        confidence = 0.4

    if is_fake_checking_phrase(answer):
        answer = sanitize_fake_checking(
            answer,
            tool_started=False,
            intent=inferred,
            context={"user_text": user_text, "has_cart": has_cart, "sid": sid},
        )
        logger.info("direct_llm_answer_repaired sid=%s intent=%s", sid, inferred)

    logger.info("direct_llm_answer_complete sid=%s chars=%d intent=%s", sid, len(answer), inferred)
    return DirectAnswerResult(answer=answer, intent=inferred, confidence=confidence)
