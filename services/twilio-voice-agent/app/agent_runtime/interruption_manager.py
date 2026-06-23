"""Interrupt repair — repeat last response instead of generic fallback (v4.13)."""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)

_REPEAT_PAT = re.compile(
    r"^\s*(what\??|what did you say|you are what|repeat|say that again|"
    r"what was that|pardon|your what|what you say)\s*[.!?]?\s*$",
    re.I,
)


@dataclass
class InterruptContext:
    interrupted: bool = False
    previous_intent: str = ""
    previous_response: str = ""
    previous_pipeline_intent: str = ""
    cancelled_response_discarded: bool = False
    repair_pending: bool = False


_contexts: dict[str, InterruptContext] = {}


def get_interrupt_context(call_sid: str) -> InterruptContext:
    if call_sid not in _contexts:
        _contexts[call_sid] = InterruptContext()
    return _contexts[call_sid]


def clear_interrupt_context(call_sid: str) -> None:
    _contexts.pop(call_sid, None)


def record_interrupt(
    call_sid: str,
    *,
    previous_intent: str = "",
    previous_pipeline_intent: str = "",
    previous_response: str = "",
) -> None:
    ctx = get_interrupt_context(call_sid)
    ctx.interrupted = True
    ctx.repair_pending = True
    ctx.previous_intent = previous_intent
    ctx.previous_pipeline_intent = previous_pipeline_intent
    ctx.previous_response = previous_response
    ctx.cancelled_response_discarded = True
    logger.info(
        "interrupt_detected sid=%s previous_intent=%s",
        call_sid[:6], previous_intent or "none",
    )
    logger.info(
        "cancelled_response_discarded sid=%s",
        call_sid[:6],
    )


def classify_interrupt_repair(caller_text: str) -> Optional[str]:
    """Return repair_type if utterance is interrupt repair."""
    t = (caller_text or "").strip()
    if _REPEAT_PAT.match(t):
        return "repeat_last"
    if re.search(r"\b(what did you say|you are what|repeat)\b", t, re.I):
        return "repeat_last"
    return None


def try_interrupt_repair(
    call_sid: str,
    caller_text: str,
    last_safe_response: str = "",
) -> tuple[bool, str, str]:
    """
    Returns (handled, response_text, repair_type).

    If handled, caller should skip workers and use response_text.
    """
    ctx = get_interrupt_context(call_sid)
    if not ctx.interrupted and not ctx.repair_pending:
        return False, "", ""

    repair_type = classify_interrupt_repair(caller_text)
    if not repair_type:
        ctx.repair_pending = False
        return False, "", ""

    response = last_safe_response or ctx.previous_response
    if response:
        logger.info(
            "interrupt_repair sid=%s repair_type=%s",
            call_sid[:6], repair_type,
        )
        ctx.interrupted = False
        ctx.repair_pending = False
        return True, response, repair_type

    logger.info(
        "interrupt_repair sid=%s repair_type=clarify",
        call_sid[:6],
    )
    ctx.repair_pending = False
    return False, "", "clarify"
