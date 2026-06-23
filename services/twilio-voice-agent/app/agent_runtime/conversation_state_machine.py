"""Conversation state machine — hard turn-taking control (v4.13)."""
from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

logger = logging.getLogger(__name__)

_VALID_MODES = frozenset({
    "idle", "small_talk", "book_collection", "isbn_collection", "email_collection",
    "order_collection", "payment_flow", "facility_flow", "repair_mode",
})


class UtteranceClass(str, Enum):
    TASK_CONTINUATION = "task_continuation"
    REPAIR_REPEAT = "repair_repeat"
    NEW_TASK = "new_task"
    OFF_DOMAIN = "off_domain"
    INTERRUPTION = "interruption"
    INVALID_FOR_STATE = "invalid_for_state"
    KEEPALIVE = "keepalive"


_KEEPALIVE_PAT = re.compile(
    r"\b(hello\??|hi\??|are you there|you there|still there|"
    r"why are you not responding|why aren't you responding|"
    r"why arent you responding|can you hear me)\b",
    re.I,
)
_FRUSTRATION_PAT = re.compile(
    r"\b(what the hell|what the fuck|damn it|this is ridiculous|"
    r"not working|why not responding|what the [\*]+|\*\*\*\*)\b|"
    r"what the .*\*",
    re.I,
)
_REPEAT_PAT = re.compile(
    r"^\s*(what\??|what did you say|say that again|repeat|what was that|"
    r"your what|what you say|you are what|pardon)\s*[.!?]?\s*$",
    re.I,
)
_REPEAT_RESET_PAT = re.compile(
    r"\b(repeat again|start over|reset|check again|sorry repeat)\b",
    re.I,
)
_WAIT_PAT = re.compile(
    r"\b(wait|hold on|one moment|one second|i will give you|let me get)\b",
    re.I,
)
_IDENTITY_PAT = re.compile(
    r"\b(what(?:'s| is) your name|who are you|sureshot|sureshort|showshort|"
    r"social book|what company|what(?:'s| is) your job|what do you do|"
    r"are you .* assistant|you are .* assistant)\b",
    re.I,
)
_ISBN_CONTINUATION = re.compile(
    r"\b(isbn|digit|number|here it is|it is|it's)\b",
    re.I,
)
_PARTIAL_ISBN_MSG = (
    "I only have twelve digits. Please give me the last digit, "
    "or say repeat to start over."
)
_KEEPALIVE_MSG = "No problem, I'm here. Go ahead when you're ready."
_HERE_MSG = "Yes, I'm here."


@dataclass
class ConversationState:
    mode: str = "idle"
    expected_next: str = ""
    active_task: str = ""
    last_agent_question: str = ""
    last_confirmable_action: str = ""
    pending_isbn_digits: str = ""
    pending_email_text: str = ""
    pending_order_digits: str = ""
    frustration_count: int = 0
    last_user_interrupt: bool = False
    last_safe_response: str = ""
    blocked_product_search_count: int = 0
    hold_started_at: float = 0.0
    isbn_partial_since: float = 0.0
    last_mode_before_repair: str = ""


@dataclass
class StateTransitionResult:
    state: ConversationState
    utterance_class: UtteranceClass = UtteranceClass.TASK_CONTINUATION
    should_answer: bool = True
    should_hold: bool = False
    repair_response: str = ""
    exit_collection: bool = False
    clear_isbn_buffer: bool = False
    transition_reason: str = ""


_machines: dict[str, ConversationState] = {}


def get_conversation_state(call_sid: str) -> ConversationState:
    if call_sid not in _machines:
        _machines[call_sid] = ConversationState()
    return _machines[call_sid]


def clear_conversation_state(call_sid: str) -> None:
    _machines.pop(call_sid, None)


def clear_all_conversation_states() -> None:
    _machines.clear()


def _digit_count(text: str) -> int:
    return len("".join(c for c in (text or "") if c.isdigit()))


def _log_state(sid: str, state: ConversationState) -> None:
    logger.info(
        "conversation_state sid=%s mode=%s expected_next=%s",
        sid[:6], state.mode, state.expected_next or "none",
    )


def _transition(
    sid: str,
    state: ConversationState,
    new_mode: str,
    reason: str,
) -> None:
    old = state.mode
    if old != new_mode:
        logger.info(
            "state_transition sid=%s from=%s to=%s reason=%s",
            sid[:6], old, new_mode, reason,
        )
        state.mode = new_mode


def classify_utterance(
    caller_text: str,
    state: ConversationState,
    *,
    pipeline_intent: str = "",
) -> UtteranceClass:
    t = (caller_text or "").strip()
    if not t:
        return UtteranceClass.INVALID_FOR_STATE

    if state.last_user_interrupt and _REPEAT_PAT.search(t):
        return UtteranceClass.INTERRUPTION

    if _REPEAT_PAT.search(t) and pipeline_intent in (
        "repeat_clarification", "unknown",
    ):
        return UtteranceClass.REPAIR_REPEAT

    if _KEEPALIVE_PAT.search(t) or _FRUSTRATION_PAT.search(t):
        if state.mode == "isbn_collection":
            return UtteranceClass.KEEPALIVE
        return UtteranceClass.REPAIR_REPEAT

    if _IDENTITY_PAT.search(t):
        return UtteranceClass.REPAIR_REPEAT

    if state.mode == "isbn_collection":
        digits = _digit_count(t)
        if digits == 0 and not _ISBN_CONTINUATION.search(t) and not _WAIT_PAT.search(t):
            if _KEEPALIVE_PAT.search(t) or _FRUSTRATION_PAT.search(t):
                return UtteranceClass.KEEPALIVE
            return UtteranceClass.INVALID_FOR_STATE
        if digits > 0:
            return UtteranceClass.TASK_CONTINUATION

    if _WAIT_PAT.search(t):
        return UtteranceClass.TASK_CONTINUATION

    return UtteranceClass.NEW_TASK


def process_turn(
    call_sid: str,
    caller_text: str,
    *,
    pipeline_intent: str = "",
    settings=None,
    isbn_buffer: str = "",
) -> StateTransitionResult:
    """Update conversation state and return routing hints."""
    from ..config import get_settings
    s = settings or get_settings()
    sid = call_sid or ""
    state = get_conversation_state(sid)
    t = (caller_text or "").strip()
    now = time.monotonic()

    _log_state(sid, state)
    result = StateTransitionResult(state=state)

    utterance = classify_utterance(t, state, pipeline_intent=pipeline_intent)
    result.utterance_class = utterance

    # ISBN collection mode detection
    digits_in_turn = _digit_count(t)
    if isbn_buffer or digits_in_turn >= 3 or pipeline_intent in (
        "isbn_search", "isbn_collection",
    ):
        if state.mode != "isbn_collection" and digits_in_turn >= 3:
            _transition(sid, state, "isbn_collection", "isbn_digits_detected")
            state.expected_next = "isbn_13_digits"
            state.active_task = "collect_isbn"

    if pipeline_intent in ("vague_book_request", "book_title_search", "product_search"):
        if state.mode == "idle":
            _transition(sid, state, "book_collection", "book_flow_started")
            state.expected_next = "title_or_isbn_or_subject"
            state.active_task = "find_book"

    # Repeat reset
    if _REPEAT_RESET_PAT.search(t):
        state.pending_isbn_digits = ""
        state.isbn_partial_since = 0.0
        result.clear_isbn_buffer = True
        _transition(sid, state, "book_collection", "isbn_reset")
        state.expected_next = "title_or_isbn_or_subject"
        logger.info("state_repair sid=%s reason=isbn_buffer_reset", sid[:6])
        return result

    # ISBN hold escape on keepalive/frustration
    if state.mode == "isbn_collection" and utterance in (
        UtteranceClass.KEEPALIVE, UtteranceClass.REPAIR_REPEAT,
    ):
        if _KEEPALIVE_PAT.search(t) or _FRUSTRATION_PAT.search(t):
            logger.info(
                "state_exit_collection sid=%s from=isbn_collection reason=keepalive_or_frustration",
                sid[:6],
            )
            result.exit_collection = True
            partial = state.pending_isbn_digits or isbn_buffer
            digit_n = _digit_count(partial)
            if digit_n in (10, 11, 12):
                result.repair_response = (
                    f"{_HERE_MSG} {_PARTIAL_ISBN_MSG}"
                )
            elif _FRUSTRATION_PAT.search(t):
                state.frustration_count += 1
                _transition(sid, state, "repair_mode", "frustration_in_isbn")
                result.repair_response = ""
            else:
                result.repair_response = _HERE_MSG
            state.pending_isbn_digits = ""
            state.isbn_partial_since = 0.0
            result.clear_isbn_buffer = True
            state.last_mode_before_repair = "isbn_collection"
            _transition(sid, state, "book_collection", "escaped_isbn_hold")
            return result

    # Partial ISBN timeout
    partial_digits = state.pending_isbn_digits or isbn_buffer
    digit_count = _digit_count(partial_digits)
    if state.mode == "isbn_collection" and 10 <= digit_count <= 12:
        if state.isbn_partial_since <= 0:
            state.isbn_partial_since = now
        timeout_s = getattr(s, "VOICE_ISBN_PARTIAL_TIMEOUT_MS", 5000) / 1000
        if now - state.isbn_partial_since >= timeout_s:
            result.repair_response = _PARTIAL_ISBN_MSG
            logger.info("state_repair sid=%s reason=partial_isbn_timeout digits=%d", sid[:6], digit_count)
            result.should_answer = True
            return result

    # Wait hold with max window
    if _WAIT_PAT.search(t):
        if state.hold_started_at <= 0:
            state.hold_started_at = now
        max_hold_s = getattr(s, "VOICE_COLLECTION_MAX_HOLD_MS", 7000) / 1000
        keepalive_enabled = getattr(s, "VOICE_COLLECTION_KEEPALIVE_ENABLED", True)
        if keepalive_enabled and now - state.hold_started_at >= max_hold_s:
            result.repair_response = _KEEPALIVE_MSG
            state.hold_started_at = 0.0
            logger.info("state_repair sid=%s reason=wait_hold_timeout", sid[:6])
            return result
        result.should_hold = True
        result.should_answer = False
        return result

    state.hold_started_at = 0.0

    # Track ISBN digits in state
    if digits_in_turn > 0:
        merged = (state.pending_isbn_digits + "".join(c for c in t if c.isdigit()))[:13]
        state.pending_isbn_digits = merged
        if _digit_count(merged) < 13:
            state.isbn_partial_since = state.isbn_partial_since or now

    # Identity inside book flow — answer identity, keep flow
    if _IDENTITY_PAT.search(t) and state.mode in ("book_collection", "isbn_collection"):
        state.last_mode_before_repair = state.mode
        result.utterance_class = UtteranceClass.REPAIR_REPEAT
        return result

    # What? repeats last response (strict repeat-only utterances)
    if _REPEAT_PAT.match(t) and state.last_safe_response and not _IDENTITY_PAT.search(t):
        result.utterance_class = UtteranceClass.REPAIR_REPEAT
        result.repair_response = state.last_safe_response
        logger.info("state_repair sid=%s reason=repeat_last_response", sid[:6])
        return result

    return result


def record_safe_response(call_sid: str, response: str) -> None:
    state = get_conversation_state(call_sid)
    if response and response.strip():
        state.last_safe_response = response.strip()


def record_interrupt(call_sid: str) -> None:
    state = get_conversation_state(call_sid)
    state.last_user_interrupt = True
    logger.info("interrupt_detected sid=%s previous_mode=%s", call_sid[:6], state.mode)


def clear_interrupt(call_sid: str) -> None:
    state = get_conversation_state(call_sid)
    state.last_user_interrupt = False
