"""
Voice Commerce Runtime — single live turn handler for SureShot Books.

Flow:
  Twilio/ConversationRelay → Turn Assembler → Fast Classifier → Main LLM Brain
  → Tool Router → Safety Gates → Final Response → Voice
"""
from __future__ import annotations

import asyncio
import heapq
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Optional, TYPE_CHECKING

from ..agent_runtime.commerce_flow_state import (
    COMMERCE_FLOW_VERSION,
    advance_commerce_state_silent,
    enforce_commerce_response,
    process_commerce_turn,
    record_commerce_voice_reply,
    try_commerce_hold_reply,
    try_commerce_repeat_reply,
)
from ..agent_runtime.payment_flow_state import (
    enforce_payment_response,
    process_payment_turn,
    record_payment_voice_reply,
    try_payment_hold_reply,
    try_payment_repeat_reply,
)
from ..agent_runtime.types import RuntimeTurnResult
from ..agents.main_commerce_brain import MainCommerceBrain
from ..cart.commerce_cart_service import CommerceCartService
from ..payment.email_state import PAYMENT_AUTO_SEND_ENABLED
from ..payment.payment_state_machine import needs_deferred_payment_auto_send
from .cart_memory import cart_memory_runtime_scope, sync_cart_memory_from_ledger
from .execution_policy_resolver import (
    EXECUTION_POLICY_DETERMINISTIC,
    EXECUTION_POLICY_SHORT_CIRCUIT,
    ExecutionFsmState,
    apply_execution_policy_to_plan,
    assign_plan_fast_route_from_policy,
    build_execution_fsm_state,
    policy_allows_llm,
    probe_brain_gate_active,
    resolve_brain_gate_reply,
    resolve_execution_policy,
)
from .fast_classifier import (
    ClassificationResult,
    LOCK_LLM_BRAIN,
    LOCK_ORDER_WORKFLOW,
    LOCK_PRODUCT_SEARCH_WORKFLOW,
    apply_intent_lock,
    apply_product_intent_hard_gate,
    bind_session_intent_lock,
    classify,
    locked_workflow_allows_llm,
    locked_workflow_requires_product_search,
    normalize_speech_text,
    product_intent_detected,
)

if TYPE_CHECKING:
    from ..state.models import SafeCallerContext, SessionState

logger = logging.getLogger(__name__)

RUNTIME_MODE = "voice_commerce_runtime"

_OPENAI_FALLBACK = (
    "I'm having a little trouble with that. "
    "Could you say that again — are you looking to buy something, check an order, or cancel an order?"
)

_STUCK_RECOVERY = (
    "Sorry, I didn't quite get that. "
    "Tell me what you need — buying a book, order status, cancellation, or something else?"
)

_GUIDED_AWAITING_ORDER_PROMPT = "Please tell me your order number."

# ── Voice Stability Normalization Layer (TTS-only — no workflow changes) ─────

_REPEATED_WORD_RE = re.compile(r"\b(\w+)(?:\s+\1\b)+", re.I)
_ACK_FRAGMENT_RE = re.compile(
    r"^(Yes|Yeah|Yep|Okay|Ok|Sure|Right|So|Well)\.\s+([A-Za-z].*)$",
    re.I,
)
_DANGLING_ACK_ONLY_RE = re.compile(
    r"^(Yes|Yeah|Yep|Okay|Ok|Sure|Right)\.\s*$",
    re.I,
)
_MULTI_SPACE_RE = re.compile(r"\s+")
_PUNCT_SPACE_FIX_RE = re.compile(r"([,.!?])([^\s\"'\)])")
_ABBREV_EXPANSIONS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\bMr\.\s*", re.I), "Mister "),
    (re.compile(r"\bMrs\.\s*", re.I), "Missus "),
    (re.compile(r"\bMs\.\s*", re.I), "Ms "),
    (re.compile(r"\bDr\.\s*", re.I), "Doctor "),
    (re.compile(r"\bvs\.\s*", re.I), "versus "),
    (re.compile(r"\be\.g\.\s*", re.I), "for example "),
    (re.compile(r"\bi\.e\.\s*", re.I), "that is "),
    (re.compile(r"\betc\.\s*", re.I), "etcetera "),
    (re.compile(r"\bISBN\b"), "I S B N"),
)

_MIN_TTS_WORDS = 5
_KNOWN_PARTIAL_CUTS = frozenset({
    "fro", "bu", "lo", "fr", "th", "wi", "wh", "co", "un", "ve", "re",
})
_SENTENCE_TERMINAL_RE = re.compile(r"[.!?]\s*$")
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")


@dataclass
class FinalVoicePipelineResult:
    """Outcome of final_voice_pipeline — empty text means TTS must not run."""

    text: str = ""
    blocked: bool = False
    reason: str = ""
    complete: bool = False


def _word_count(text: str) -> int:
    return len((text or "").split())


def _is_sentence_complete(text: str) -> bool:
    stripped = (text or "").strip()
    return bool(stripped) and stripped[-1] in ".!?"


def _strip_partial_cuts(text: str) -> str:
    """Drop known streaming fragments and trailing orphan syllables."""
    words = (text or "").split()
    if not words:
        return ""

    cleaned: list[str] = []
    for word in words:
        core = re.sub(r"[^\w]", "", word).lower()
        if core in _KNOWN_PARTIAL_CUTS:
            continue
        cleaned.append(word)

    if cleaned and not _is_sentence_complete(" ".join(cleaned)):
        last_core = re.sub(r"[^\w]", "", cleaned[-1]).lower()
        if len(last_core) <= 2:
            cleaned.pop()

    return " ".join(cleaned).strip()


def _merge_incomplete_sentences(
    text: str,
    *,
    pending_fragment: str = "",
    last_valid_sentence: str = "",
) -> str:
    """Join buffered fragments and continue from the last valid sentence."""
    parts = [p.strip() for p in (pending_fragment, text) if (p or "").strip()]
    merged = " ".join(parts).strip()
    if not merged:
        return ""

    if last_valid_sentence and merged[0].islower():
        base = last_valid_sentence.rstrip(".!?").strip()
        if base:
            merged = f"{base} {merged}"

    return _MULTI_SPACE_RE.sub(" ", merged).strip()


def _predict_sentence_end(text: str) -> str:
    """Add terminal punctuation when the utterance is long enough to speak."""
    stripped = (text or "").strip()
    if not stripped:
        return ""
    if _is_sentence_complete(stripped):
        return stripped
    if _word_count(stripped) >= _MIN_TTS_WORDS:
        return f"{stripped}."
    return stripped


def _get_tts_sentence_cache(session: Optional["SessionState"]) -> tuple[str, str]:
    if session is None:
        return "", ""
    pending = str(getattr(session, "_tts_pending_fragment", "") or "")
    last_valid = str(getattr(session, "_tts_last_valid_sentence", "") or "")
    return pending, last_valid


def _set_tts_sentence_cache(
    session: Optional["SessionState"],
    *,
    pending_fragment: str = "",
    last_valid_sentence: str = "",
) -> None:
    if session is None:
        return
    session._tts_pending_fragment = pending_fragment  # type: ignore[attr-defined]
    session._tts_last_valid_sentence = last_valid_sentence  # type: ignore[attr-defined]


def clear_tts_sentence_cache(session: Optional["SessionState"]) -> None:
    _set_tts_sentence_cache(session, pending_fragment="", last_valid_sentence="")


def final_voice_pipeline(
    text: str,
    session: Optional["SessionState"] = None,
    *,
    user_text: str = "",
    require_complete: bool = True,
    min_words: int = _MIN_TTS_WORDS,
    allow_short: bool = False,
) -> FinalVoicePipelineResult:
    """
    Last gate before TTS — merge fragments, strip cuts, enforce completeness.

    Blocks output when the sentence is incomplete or shorter than min_words.
    """
    from ..email.speller import is_email_readback_tts_part, is_preserved_email_readback

    raw = (text or "").strip()
    if not raw:
        return FinalVoicePipelineResult(blocked=True, reason="empty", complete=False)
    if is_preserved_email_readback(raw) or is_email_readback_tts_part(raw):
        return FinalVoicePipelineResult(text=raw, complete=True)

    pending, last_valid = _get_tts_sentence_cache(session)
    merged = _merge_incomplete_sentences(
        raw,
        pending_fragment=pending,
        last_valid_sentence=last_valid,
    )
    merged = _strip_partial_cuts(merged)

    if not merged:
        _set_tts_sentence_cache(session, pending_fragment=pending + raw, last_valid_sentence=last_valid)
        return FinalVoicePipelineResult(blocked=True, reason="partial_cut_only", complete=False)

    pre_complete = _is_sentence_complete(merged)
    if require_complete and not pre_complete:
        _set_tts_sentence_cache(session, pending_fragment=merged, last_valid_sentence=last_valid)
        return FinalVoicePipelineResult(
            blocked=True,
            reason="incomplete_sentence",
            complete=False,
        )

    merged = normalize_tts_text(merged, user_text=user_text)

    if not merged:
        _set_tts_sentence_cache(session, pending_fragment=pending + raw, last_valid_sentence=last_valid)
        return FinalVoicePipelineResult(blocked=True, reason="partial_cut_only", complete=False)

    complete = _is_sentence_complete(merged)
    words = _word_count(merged)

    if not allow_short and words < min_words:
        _set_tts_sentence_cache(session, pending_fragment=merged, last_valid_sentence=last_valid)
        return FinalVoicePipelineResult(
            blocked=True,
            reason="too_short",
            complete=complete,
        )

    if not complete and not require_complete:
        merged = _predict_sentence_end(merged)
        complete = _is_sentence_complete(merged)

    if session is not None and complete and merged:
        _set_tts_sentence_cache(session, pending_fragment="", last_valid_sentence=merged)

    return FinalVoicePipelineResult(text=merged, blocked=False, complete=complete)


def normalize_tts_text(text: str, *, user_text: str = "") -> str:
    """
    Stabilize spoken text before TTS — structural cleanup only.

    - Collapse repeated words ("I I need" → "I need")
    - Merge ack fragments ("Yes. The book" → "Yes, the book")
    - Expand common abbreviations for speech
    - Normalize punctuation and spacing for TTS
    """
    cleaned = (text or "").strip()
    if not cleaned:
        return ""

    cleaned = _MULTI_SPACE_RE.sub(" ", cleaned)

    prev = None
    while prev != cleaned:
        prev = cleaned
        cleaned = _REPEATED_WORD_RE.sub(r"\1", cleaned)

    ack_match = _ACK_FRAGMENT_RE.match(cleaned)
    if ack_match:
        ack = ack_match.group(1)
        rest = ack_match.group(2).strip()
        if rest:
            cleaned = f"{ack}, {rest[0].lower()}{rest[1:]}" if len(rest) > 1 else f"{ack}, {rest.lower()}"

    if _DANGLING_ACK_ONLY_RE.match(cleaned) and (user_text or "").strip():
        topic = _infer_ack_completion_topic(user_text)
        if topic:
            cleaned = f"{cleaned.rstrip('.')}, {topic}."

    for pattern, replacement in _ABBREV_EXPANSIONS:
        cleaned = pattern.sub(replacement, cleaned)

    cleaned = re.sub(r"\.{2,}", ".", cleaned)
    cleaned = re.sub(r"!{2,}", "!", cleaned)
    cleaned = re.sub(r"\?{2,}", "?", cleaned)
    cleaned = re.sub(r"\s+([,.!?])", r"\1", cleaned)
    cleaned = _PUNCT_SPACE_FIX_RE.sub(r"\1 \2", cleaned)
    cleaned = _MULTI_SPACE_RE.sub(" ", cleaned).strip()

    # Ensure terminal punctuation for complete thoughts (voice pacing).
    if cleaned and cleaned[-1] not in ".!?":
        if len(cleaned.split()) >= 4:
            cleaned = f"{cleaned}."

    return cleaned


def _infer_ack_completion_topic(user_text: str) -> str:
    """Light context hint when the model emits a dangling acknowledgment."""
    lower = (user_text or "").lower()
    if re.search(r"\b(book|isbn|title|author|copy|copies)\b", lower):
        return "about the book"
    if re.search(r"\b(order|tracking|shipment|delivery)\b", lower):
        return "about your order"
    if re.search(r"\b(cancel|refund|return)\b", lower):
        return "I can help with that"
    if re.search(r"\b(email|payment|checkout)\b", lower):
        return "let's continue"
    return ""


def finalize_voice_output(
    text: str,
    session: Optional["SessionState"] = None,
    *,
    user_text: str = "",
    log_metrics: bool = True,
    require_complete: bool = True,
    allow_short: bool = False,
) -> str:
    """
    Final TTS text pipeline — SpeechPacer runs only here.

    Upstream layers (FSM, classifier, cart/payment) must emit raw semantic text.
    Outbound TTS must use schedule_voice_output (which calls this) — never send
    formatted text to Twilio directly.
    """
    from ..email.speller import is_email_readback_tts_part, is_preserved_email_readback
    from ..voice.voice_response_formatter import SpeechPacer, ensure_emotion_field

    raw = (text or "").strip()
    if not raw:
        return ""

    bypass_contract = is_preserved_email_readback(raw) or is_email_readback_tts_part(raw)

    if bypass_contract:
        semantic = raw
    else:
        pipeline = final_voice_pipeline(
            raw,
            session,
            user_text=user_text,
            require_complete=require_complete,
            allow_short=allow_short,
        )
        if pipeline.blocked or not pipeline.text:
            if log_metrics:
                logger.info(
                    "voice_pipeline_blocked reason=%s complete=%s",
                    pipeline.reason or "-",
                    str(pipeline.complete).lower(),
                )
            return ""

        normalized = pipeline.text
        stability_changed = normalized != raw

        semantic = VoiceCommerceRuntime._apply_voice_output_pipeline(
            normalized,
            session,
            user_text=user_text,
        )
        semantic = semantic.replace("\n", " .. ")
        semantic = re.sub(r"\.{6,}", ".....", semantic)
        semantic = re.sub(r"[ \t]+", " ", semantic).strip()

        if log_metrics:
            logger.info(
                "voice_stability_normalized=%s voice_output_length_before=%d "
                "voice_output_length_after=%d voice_pipeline_complete=%s",
                str(stability_changed).lower(),
                len(raw),
                len(semantic),
                str(pipeline.complete).lower(),
            )

    if not semantic:
        return ""

    return SpeechPacer().pace(
        semantic,
        emotion_field=ensure_emotion_field(session),
    )


# ── Voice emission scheduler — one active TTS emission per session ─────────────

_VOICE_EMISSION_SCHEDULER: Optional["VoiceEmissionScheduler"] = None
_SESSION_EMISSION_LOCKS: dict[str, asyncio.Lock] = {}
_EMISSION_SEQ = 0

# Emission priorities — higher runs first; critical flows flush lower-priority queue.
VOICE_PRIORITY_DEFAULT = 0
VOICE_PRIORITY_CART = 10
VOICE_PRIORITY_PAYMENT_LINK = 30
VOICE_PRIORITY_EMAIL_SPELL = 50

_SPEECH_COMPLETION_POLL_S = 0.025
_SPEECH_COMPLETION_TIMEOUT_S = 30.0


@dataclass(order=True)
class _VoiceEmissionJob:
    """Queued TTS payload — higher priority emits before lower."""

    sort_key: tuple[int, int] = field(init=False, repr=False)
    text: str = field(compare=False, default="")
    priority: int = field(compare=False, default=0)
    interruptible: bool = field(compare=False, default=True)
    play_immediately: bool = field(compare=False, default=False)
    send_last: bool = field(compare=False, default=True)
    stream_end: bool = field(compare=False, default=False)

    def __post_init__(self) -> None:
        self.sort_key = (-self.priority, _next_emission_seq())


def _next_emission_seq() -> int:
    global _EMISSION_SEQ
    _EMISSION_SEQ += 1
    return _EMISSION_SEQ


def _emission_session_key(session: "SessionState") -> str:
    return (session.session_id or session.call_sid or str(id(session))).strip()


def _emission_lock(session: "SessionState") -> asyncio.Lock:
    key = _emission_session_key(session)
    lock = _SESSION_EMISSION_LOCKS.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _SESSION_EMISSION_LOCKS[key] = lock
    return lock


def _emission_queue(session: "SessionState") -> list[_VoiceEmissionJob]:
    queue = getattr(session, "_voice_emission_queue", None)
    if queue is None:
        queue = []
        session._voice_emission_queue = queue  # type: ignore[attr-defined]
    return queue


def is_speaking(session: "SessionState") -> bool:
    """True while a voice emission is active or being drained for this session."""
    return VoiceEmissionScheduler.instance().is_speaking(session)


def flush_voice_queue(session: "SessionState") -> list[str]:
    """Drop pending queued speech and return the formatted texts (no TTS)."""
    return VoiceEmissionScheduler.instance().flush_voice_queue(session)


def has_pending_voice_queue(session: "SessionState") -> bool:
    return bool(_emission_queue(session))


async def wait_for_speech_completion_before_next_action(
    session: "SessionState",
    *,
    timeout: float = _SPEECH_COMPLETION_TIMEOUT_S,
) -> None:
    """Block until active TTS and queued emissions finish for this session."""
    await VoiceEmissionScheduler.instance().wait_for_speech_completion(
        session, timeout=timeout,
    )


async def flush_voice_queue_before_critical_action(
    session: "SessionState",
    *,
    timeout: float = _SPEECH_COMPLETION_TIMEOUT_S,
) -> list[str]:
    """Drop stale queued speech, then wait for any active emission to finish."""
    flushed = flush_voice_queue(session)
    await wait_for_speech_completion_before_next_action(session, timeout=timeout)
    if flushed:
        logger.info(
            "voice_queue_flushed_before_critical sid=%s dropped=%d",
            (session.call_sid or "")[:6],
            len(flushed),
        )
    return flushed


async def ensure_email_spell_inactive_before_payment(
    session: "SessionState",
    *,
    timeout: float = _SPEECH_COMPLETION_TIMEOUT_S,
) -> None:
    """Payment link speech must never overlap email letter-by-letter readback."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if getattr(session, "voice_interrupted", False):
            return
        spell_active = bool(getattr(session, "_email_spell_emission_active", False))
        if not spell_active and not is_speaking(session) and not has_pending_voice_queue(session):
            return
        await asyncio.sleep(_SPEECH_COMPLETION_POLL_S)
    logger.warning(
        "email_spell_payment_wait_timeout sid=%s spell_active=%s",
        (session.call_sid or "")[:6],
        bool(getattr(session, "_email_spell_emission_active", False)),
    )


async def prepare_critical_voice_action(
    session: "SessionState",
    *,
    action: str = "",
    timeout: float = _SPEECH_COMPLETION_TIMEOUT_S,
) -> list[str]:
    """Flush queue + await speech idle before checkout, email capture, or escalation."""
    flushed = await flush_voice_queue_before_critical_action(session, timeout=timeout)
    if action:
        logger.info(
            "critical_voice_action_ready sid=%s action=%s",
            (session.call_sid or "")[:6],
            action,
        )
    return flushed


async def schedule_voice_output(
    session: "SessionState",
    text: str,
    priority: int = 0,
    *,
    send: Callable | None = None,
    user_text: str = "",
    interruptible: bool = True,
    play_immediately: bool = False,
    send_last: bool = True,
    already_finalized: bool = False,
    stream_end: bool = False,
    log_metrics: bool = True,
    allow_short: bool = True,
    require_complete: bool = True,
) -> str:
    """
    Queue formatted speech for emission — calls finalize_voice_output unless
    ``already_finalized`` or ``stream_end``.
    """
    return await VoiceEmissionScheduler.instance().schedule_voice_output(
        session,
        text,
        priority,
        send=send,
        user_text=user_text,
        interruptible=interruptible,
        play_immediately=play_immediately,
        send_last=send_last,
        already_finalized=already_finalized,
        stream_end=stream_end,
        log_metrics=log_metrics,
        allow_short=allow_short,
        require_complete=require_complete,
    )


class VoiceEmissionScheduler:
    """Serializes outbound TTS — one active emission per session."""

    def __init__(self) -> None:
        pass

    @classmethod
    def instance(cls) -> "VoiceEmissionScheduler":
        global _VOICE_EMISSION_SCHEDULER
        if _VOICE_EMISSION_SCHEDULER is None:
            _VOICE_EMISSION_SCHEDULER = cls()
        return _VOICE_EMISSION_SCHEDULER

    def is_speaking(self, session: "SessionState") -> bool:
        if getattr(session, "voice_interrupted", False):
            return False
        if bool(getattr(session, "_voice_emission_active", False)):
            return True
        if bool(getattr(session, "is_speaking", False)):
            return True
        if bool(getattr(session, "_voice_emission_draining", False)):
            return True
        return False

    def flush_voice_queue(self, session: "SessionState") -> list[str]:
        queue = _emission_queue(session)
        pending = [job.text for job in sorted(queue) if job.text]
        queue.clear()
        return pending

    async def wait_for_speech_completion(
        self,
        session: "SessionState",
        *,
        timeout: float = _SPEECH_COMPLETION_TIMEOUT_S,
    ) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if getattr(session, "voice_interrupted", False):
                return
            if (
                not self.is_speaking(session)
                and not _emission_queue(session)
            ):
                return
            await asyncio.sleep(_SPEECH_COMPLETION_POLL_S)
        logger.warning(
            "voice_speech_completion_timeout sid=%s speaking=%s queued=%d",
            (session.call_sid or "")[:6],
            str(self.is_speaking(session)).lower(),
            len(_emission_queue(session)),
        )

    async def schedule_voice_output(
        self,
        session: "SessionState",
        text: str,
        priority: int = 0,
        *,
        send: Callable | None = None,
        user_text: str = "",
        interruptible: bool = True,
        play_immediately: bool = False,
        send_last: bool = True,
        already_finalized: bool = False,
        stream_end: bool = False,
        log_metrics: bool = True,
        allow_short: bool = True,
        require_complete: bool = True,
    ) -> str:
        send_fn = send or getattr(session, "_active_voice_send", None)
        if send_fn is None:
            logger.warning("voice_emission_skipped reason=no_send_fn sid=%s", (session.call_sid or "")[:6])
            return ""

        if stream_end:
            formatted = ""
        elif already_finalized:
            formatted = (text or "").strip()
        else:
            formatted = finalize_voice_output(
                text,
                session,
                user_text=user_text,
                log_metrics=log_metrics,
                allow_short=allow_short,
                require_complete=require_complete,
            )

        if not formatted and not stream_end:
            return ""

        job = _VoiceEmissionJob(
            text=formatted,
            priority=priority,
            interruptible=interruptible,
            play_immediately=play_immediately,
            send_last=send_last,
            stream_end=stream_end,
        )

        async with _emission_lock(session):
            if self.is_speaking(session) and not interruptible:
                heapq.heappush(_emission_queue(session), job)
                return formatted

            await self._emit_job(session, send_fn, job)
            await self._drain_queue(session, send_fn)

        return formatted

    async def _drain_queue(self, session: "SessionState", send: Callable) -> None:
        if getattr(session, "_voice_emission_draining", False):
            return
        session._voice_emission_draining = True  # type: ignore[attr-defined]
        try:
            queue = _emission_queue(session)
            while queue and not getattr(session, "voice_interrupted", False):
                job = heapq.heappop(queue)
                await self._emit_job(session, send, job)
        finally:
            session._voice_emission_draining = False  # type: ignore[attr-defined]

    async def _emit_job(
        self,
        session: "SessionState",
        send: Callable,
        job: _VoiceEmissionJob,
    ) -> None:
        if getattr(session, "voice_interrupted", False):
            return

        session._voice_emission_active = True  # type: ignore[attr-defined]
        try:
            if job.stream_end:
                await _await_send(
                    send,
                    {"type": "text", "token": "", "last": True},
                    session,
                )
                return

            if not job.text:
                return

            payload: dict = {
                "type": "text",
                "token": job.text,
                "interruptible": job.interruptible,
            }
            if job.play_immediately:
                payload["play_immediately"] = True
                payload["last"] = job.send_last
            else:
                payload["last"] = False

            await _await_send(send, payload, session)

            if job.send_last and not job.play_immediately:
                await _await_send(
                    send,
                    {"type": "text", "token": "", "last": True},
                    session,
                )
        finally:
            session._voice_emission_active = False  # type: ignore[attr-defined]


from ..agent_runtime.voice_workflows import (
    PRODUCT_CLARIFICATION_REPLY as _PRODUCT_CLARIFICATION_REPLY,
    detect_product_search_intent,
    has_structured_product_search_input,
    has_valid_product_identifier,
    isbn_detected as _isbn_detected,
    product_clarification_turn_result,
    product_title_detected as _product_title_detected,
    requires_product_clarification,
)

_runtime: Optional["VoiceCommerceRuntime"] = None

_LEGACY_PRODUCT_SEARCH_ROUTES = frozenset({
    "title_catalog_hunt",
    "product_catalog_hunt",
    "_try_title_catalog_hunt",
    "_try_isbn_product_hunt",
})


def _session_from_legacy_args(args: tuple, kwargs: dict) -> Optional["SessionState"]:
    if args:
        candidate = args[0]
        if hasattr(candidate, "call_sid"):
            return candidate  # type: ignore[return-value]
    session = kwargs.get("session")
    if session is not None and hasattr(session, "call_sid"):
        return session  # type: ignore[return-value]
    return None


def _raise_legacy_product_route_violation(
    route_name: str,
    *,
    session: Optional["SessionState"] = None,
) -> None:
    """Hard-stop any fragmented product search pipeline outside the canonical workflow."""
    from ..agent_runtime.workflow_contracts import WorkflowViolationError
    from ..observability.workflow_events import (
        STEP_LEGACY_ROUTE_ATTEMPT_DETECTED,
        emit_event,
    )

    emit_event(
        {
            "event_type": "workflow_transition",
            "domain": "product_search",
            "step": STEP_LEGACY_ROUTE_ATTEMPT_DETECTED,
            "input_type": "unknown",
            "outcome": "fail",
            "metadata": {"legacy_route": route_name},
        },
        session=session,
    )
    logger.error("legacy_route_attempt_detected route=%s", route_name)
    raise WorkflowViolationError(
        f"legacy product search route forbidden: {route_name}; "
        "use route_to_product_search_workflow → execute_product_search_workflow"
    )


async def title_catalog_hunt(*args, **kwargs):
    _raise_legacy_product_route_violation(
        "title_catalog_hunt",
        session=_session_from_legacy_args(args, kwargs),
    )


async def product_catalog_hunt(*args, **kwargs):
    _raise_legacy_product_route_violation(
        "product_catalog_hunt",
        session=_session_from_legacy_args(args, kwargs),
    )


async def _try_title_catalog_hunt(*args, **kwargs):
    _raise_legacy_product_route_violation(
        "_try_title_catalog_hunt",
        session=_session_from_legacy_args(args, kwargs),
    )


async def _try_isbn_product_hunt(*args, **kwargs):
    _raise_legacy_product_route_violation(
        "_try_isbn_product_hunt",
        session=_session_from_legacy_args(args, kwargs),
    )


def _enforce_plan_intent_lock(
    plan: "OrchestratorPlan",
    classification: ClassificationResult,
    session: "SessionState",
    caller_text: str,
    turn_mode: str,
) -> "OrchestratorPlan":
    """
    Map locked intent to orchestrator plan — lock cannot be overridden downstream.
    """
    from ..agent_runtime.order_flow_state import extract_order_number, order_intent_detected

    guarded = _intent_reuse_guard_triggered(session, "enforce_plan_intent_lock")
    if guarded is not None:
        classification = guarded

    locked = apply_intent_lock(classification)
    plan.classification = locked

    if locked.locked_workflow == LOCK_PRODUCT_SEARCH_WORKFLOW:
        plan.use_llm = False
        from ..agent_runtime.workflow_isolation import (
            PCS_DISCOVERY,
            product_commerce_status,
        )

        pcs = product_commerce_status(session)
        if pcs == PCS_DISCOVERY:
            if has_valid_product_identifier(session, caller_text, turn_mode):
                plan.fast_route = "product_search_workflow"
            else:
                plan.fast_route = "product_clarification"
        elif pcs not in ("", PCS_DISCOVERY, "idle"):
            plan.fast_route = "product_commerce_fsm"
        elif has_valid_product_identifier(session, caller_text, turn_mode):
            plan.fast_route = "product_search_workflow"
        else:
            plan.fast_route = "product_clarification"
        plan.reason = locked.reason or "product_search_locked"
        return plan

    if locked.locked_workflow == LOCK_ORDER_WORKFLOW:
        plan.use_llm = False
        if locked.action == "instant" and locked.instant_reply:
            plan.fast_route = "classifier_instant"
        elif (
            order_intent_detected(caller_text)
            and not extract_order_number(caller_text, session, turn_mode=turn_mode)
        ):
            plan.fast_route = "order_collection"
        else:
            plan.fast_route = "order_workflow"
        plan.reason = locked.reason or "order_workflow_locked"
        return plan

    if locked.locked_workflow == LOCK_LLM_BRAIN:
        plan.use_llm = True
        plan.fast_route = "llm_fallback" if locked.action == "brain" else "ack_then_brain"
        plan.reason = locked.reason or "llm_brain_locked"
        return plan

    if locked.action == "instant" and locked.instant_reply:
        plan.use_llm = False
        plan.fast_route = "classifier_instant"
        plan.reason = locked.reason or "deterministic_instant_locked"
    return plan


def _intent_lock_blocks_route(
    classification: ClassificationResult,
    attempted_route: str,
) -> bool:
    """True when attempted route conflicts with locked workflow."""
    locked = apply_intent_lock(classification)
    if not locked.intent_lock:
        return False
    if locked.locked_workflow == LOCK_PRODUCT_SEARCH_WORKFLOW:
        return attempted_route in ("llm_fallback", "ack_then_brain", "brain")
    if locked.locked_workflow == LOCK_LLM_BRAIN:
        return attempted_route in (
            "product_search_workflow",
            "product_clarification",
        )
    if locked.locked_workflow == LOCK_ORDER_WORKFLOW:
        return attempted_route in (
            "product_search_workflow",
            "product_clarification",
            "llm_fallback",
        )
    return False


def _explicit_search_query(
    session: "SessionState",
    text: str,
    turn_mode: str = "",
) -> bool:
    return _product_title_detected(session, text, turn_mode)


def _product_search_turn_active(
    session: "SessionState",
    text: str,
    turn_mode: str,
    classification: ClassificationResult,
    active_workflow: str,
) -> bool:
    from ..agent_runtime.workflow_isolation import WORKFLOW_PRODUCT, product_handling_allowed

    if classification.product_intent_detected or classification.skip_brain:
        return product_handling_allowed(session, turn_mode, text)
    if not product_handling_allowed(session, turn_mode, text):
        return False
    if active_workflow == WORKFLOW_PRODUCT:
        return True
    return bool(classification.is_product_search)


def _should_dispatch_product_search_workflow(
    session: "SessionState",
    text: str,
    turn_mode: str,
    classification: ClassificationResult,
    plan: "OrchestratorPlan",
    active_workflow: str,
) -> bool:
    """Step 3 — run catalog search only when ISBN/title is actionable."""
    if not has_valid_product_identifier(session, text, turn_mode):
        return False
    if locked_workflow_requires_product_search(classification):
        return True
    if _intent_lock_blocks_route(classification, "product_search_workflow"):
        return False
    from ..agent_runtime.workflow_isolation import product_handling_allowed

    if not product_handling_allowed(session, turn_mode, text):
        return False
    if plan.fast_route == "product_search_workflow":
        return True
    if _product_search_turn_active(session, text, turn_mode, classification, active_workflow):
        return True
    from ..tools.isbn import extract_isbn_candidate

    if (turn_mode or "").lower() == "isbn" or extract_isbn_candidate(text or ""):
        return True
    return False


def _should_product_clarify_turn(
    session: "SessionState",
    text: str,
    turn_mode: str,
    classification: ClassificationResult,
    plan: "OrchestratorPlan",
    active_workflow: str,
) -> bool:
    """Step 2 — intent without valid ISBN/title: clarify only, no catalog search."""
    if has_valid_product_identifier(session, text, turn_mode):
        return False
    if requires_product_clarification(
        session, text, turn_mode, classification=classification,
    ):
        return True
    if plan.fast_route == "product_clarification":
        return True
    if locked_workflow_requires_product_search(classification):
        return True
    if requires_product_clarification_before_brain(session, text, turn_mode):
        return True
    return False


def _anti_silence_allowed_for_turn(
    session: "SessionState",
    text: str,
    turn_mode: str,
    classification: ClassificationResult,
    plan: "OrchestratorPlan",
    active_workflow: str,
) -> bool:
    """Anti-silence must not preempt or substitute product_search routing."""
    if _should_product_clarify_turn(
        session, text, turn_mode, classification, plan, active_workflow,
    ):
        return False
    if _should_dispatch_product_search_workflow(
        session, text, turn_mode, classification, plan, active_workflow,
    ):
        return False
    if detect_product_search_intent(
        session, text, turn_mode, classification=classification,
    ):
        return False
    return True


def _log_intent_routing_decision(
    sid: str,
    classification: ClassificationResult,
    *,
    route: str = "",
    active_workflow: str = "",
) -> None:
    logger.info(
        "intent_routing_decision sid=%s route=%s active_workflow=%s "
        "product_intent_detected=%s skip_llm=%s skip_brain=%s reason=%s "
        "intent_lock=%s locked_workflow=%s",
        sid,
        route or "-",
        active_workflow or "-",
        str(classification.product_intent_detected).lower(),
        str(classification.skip_llm).lower(),
        str(classification.skip_brain).lower(),
        classification.reason or "-",
        str(classification.intent_lock).lower(),
        classification.locked_workflow or "-",
    )


def _llm_blocked_for_workflow(
    session: "SessionState",
    text: str,
    turn_mode: str,
    classification: ClassificationResult,
    active_workflow: str,
) -> bool:
    """
    Legacy workflow LLM gate — feeds ExecutionPolicyResolver via workflow_llm_blocked.

    Product and support workflows are deterministic — never route decisions to the LLM.
    """
    from ..agent_runtime.workflow_contracts import (
        PRODUCT_SEARCH_WORKFLOW,
        SUPPORT_HANDOFF_WORKFLOW,
    )
    from ..agent_runtime.workflow_isolation import (
        WORKFLOW_PRODUCT,
        WORKFLOW_SUPPORT,
        product_commerce_blocks_llm,
        support_handling_allowed,
    )

    if active_workflow in (WORKFLOW_PRODUCT, PRODUCT_SEARCH_WORKFLOW):
        return True
    if active_workflow in (WORKFLOW_SUPPORT, SUPPORT_HANDOFF_WORKFLOW):
        return True
    if product_commerce_blocks_llm(session):
        return True
    if support_handling_allowed(session, turn_mode, text):
        return True
    if classification.product_intent_detected or classification.skip_brain:
        return True
    if _product_search_turn_active(session, text, turn_mode, classification, active_workflow):
        return True
    if classification.is_product_search:
        return True
    return False


def requires_product_clarification_before_brain(
    session: "SessionState",
    text: str,
    turn_mode: str = "",
) -> bool:
    """
    True when speech looks like product lookup but lacks ISBN or explicit title/query.

    Catches bare titles (e.g. ``Game of Thrones``) that bypass the classifier's
    ``is_product_search`` flag yet would invite LLM catalog guessing.
    """
    if has_structured_product_search_input(session, text, turn_mode):
        return False

    from ..agent_runtime.isbn_short_circuit import (
        _catalog_query_is_actionable,
        extract_title_catalog_query,
    )
    from ..agent_runtime.order_flow_state import order_intent_detected
    from ..agent_runtime.workflow_isolation import (
        order_workflow_active,
        payment_workflow_active,
    )
    from ..runtime.fast_classifier import (
        _is_facility_question,
        _is_product_search_request,
        is_vague_product_request,
    )

    if not (text or "").strip():
        return False
    if is_vague_product_request(text):
        return False
    if order_intent_detected(text):
        return False
    if _is_facility_question(text):
        return False
    if payment_workflow_active(session, turn_mode) or order_workflow_active(session, turn_mode):
        return False

    if _is_product_search_request(text):
        return True

    query = extract_title_catalog_query(text)
    return _catalog_query_is_actionable(query)


async def _await_send(
    send: Callable,
    msg: dict,
    session: Optional["SessionState"] = None,
) -> None:
    if msg.get("type") == "text" and session is not None:
        if getattr(session, "voice_interrupted", False):
            from ..voice.voice_response_formatter import note_emotion_interrupt

            note_emotion_interrupt(session)
            session.is_speaking = False
            return
        if msg.get("token"):
            session.is_speaking = True
    out = send(msg)
    if asyncio.iscoroutine(out):
        await out
    if msg.get("type") == "text" and session is not None and bool(msg.get("last")):
        if not getattr(session, "voice_interrupted", False):
            session.is_speaking = False


def _result(answer: str, source: str = RUNTIME_MODE, *, end_call: bool = False) -> RuntimeTurnResult:
    return RuntimeTurnResult(response_text=answer, source=source, end_call=end_call)


@dataclass
class OrchestratorPlan:
    """Central turn decision — LLM is fallback, not the default brain."""

    use_llm: bool = False
    execution_policy: str = ""
    reason: str = ""
    stage: str = "idle"
    fast_route: str = ""
    plan_ms: float = 0.0
    classification: Optional[ClassificationResult] = None


class StreamingResponseBuffer:
    """
    Semantic-aware streaming buffer for natural speech rhythm.

    Emits at sentence boundaries (preferred), clause pauses (secondary), or a
    15–18 word safe fallback — never splitting protected entities (orders,
    prices, names, emails).
    """

    _FALLBACK_MIN_WORDS = 15
    _FALLBACK_MAX_WORDS = 18

    _SENTENCE_BREAK = re.compile(r"(?<=[.!?])(?:\s+|$)")
    _CLAUSE_COMMA = re.compile(r",(?:\s+|$)")
    _CLAUSE_CONJUNCTION = re.compile(
        r"\s+(?:and|but|or|so|yet|because|although|though|while|when|if)\s+",
        re.I,
    )
    _ENTITY_PATTERNS: tuple[re.Pattern[str], ...] = (
        re.compile(r"(?:order\s+#?|#)\d{4,}\b", re.I),
        re.compile(r"\$[\d,]+(?:\.\d{2})?"),
        re.compile(r"\b\d{1,4}\s+dollars?\s+and\s+\d{1,2}\s+cents\b", re.I),
        re.compile(r"[\w.+-]+@[\w.-]+\.\w+"),
        re.compile(r"\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b"),
    )

    def __init__(self) -> None:
        self._raw = ""
        self._cursor = 0

    def feed(self, token: str) -> None:
        if token:
            self._raw += token

    @property
    def pending(self) -> str:
        return self._raw[self._cursor:]

    def drain_ready(self) -> list[str]:
        chunks: list[str] = []
        while True:
            boundary = self._next_emit_boundary(self.pending, force=False)
            if boundary is None:
                break
            chunk = self.pending[:boundary].strip()
            self._advance(boundary)
            if chunk:
                chunks.append(chunk)
        return chunks

    def flush(self) -> list[str]:
        remaining = self.pending.strip()
        if not remaining:
            return []
        self._cursor = len(self._raw)
        return self._split_semantic(remaining, force_all=True)

    def _advance(self, boundary: int) -> None:
        end = self._cursor + boundary
        while end < len(self._raw) and self._raw[end] == " ":
            end += 1
        self._cursor = end

    @classmethod
    def _entity_spans(cls, text: str) -> list[tuple[int, int]]:
        spans: list[tuple[int, int]] = []
        for pattern in cls._ENTITY_PATTERNS:
            for match in pattern.finditer(text):
                spans.append((match.start(), match.end()))
        if not spans:
            return []
        spans.sort()
        merged: list[tuple[int, int]] = [spans[0]]
        for start, end in spans[1:]:
            last_start, last_end = merged[-1]
            if start <= last_end:
                merged[-1] = (last_start, max(last_end, end))
            else:
                merged.append((start, end))
        return merged

    @classmethod
    def _split_inside_entity(cls, text: str, index: int) -> bool:
        for start, end in cls._entity_spans(text):
            if start < index < end:
                return True
        return False

    @classmethod
    def _word_count(cls, text: str) -> int:
        return len(text.split())

    @classmethod
    def _word_end_offsets(cls, text: str) -> list[int]:
        ends: list[int] = []
        for match in re.finditer(r"\S+", text):
            ends.append(match.end())
        return ends

    @classmethod
    def _safe_fallback_boundary(cls, pending: str) -> int | None:
        """Force split at 15–18 words without breaking protected entities."""
        word_ends = cls._word_end_offsets(pending)
        if len(word_ends) < cls._FALLBACK_MAX_WORDS:
            return None

        preferred = word_ends[cls._FALLBACK_MAX_WORDS - 1]
        min_idx = word_ends[cls._FALLBACK_MIN_WORDS - 1] if len(word_ends) >= cls._FALLBACK_MIN_WORDS else 0

        for offset in reversed(word_ends):
            if offset < min_idx:
                break
            if offset > preferred:
                continue
            if not cls._split_inside_entity(pending, offset):
                return offset
        return None

    @classmethod
    def _next_emit_boundary(cls, pending: str, *, force: bool) -> int | None:
        if not pending.strip():
            return None

        stripped = pending.lstrip()
        lead = len(pending) - len(stripped)
        candidates: list[int] = []

        for match in cls._SENTENCE_BREAK.finditer(stripped):
            end = lead + match.start()
            while end < len(pending) and pending[end] in " \t":
                end += 1
            candidates.append(end)

        rstrip = pending.rstrip()
        if rstrip and rstrip[-1] in ".!?":
            candidates.append(len(rstrip))

        for match in cls._CLAUSE_COMMA.finditer(stripped):
            end = lead + match.end()
            if not cls._split_inside_entity(pending, end):
                candidates.append(end)

        for match in cls._CLAUSE_CONJUNCTION.finditer(stripped):
            end = lead + match.start()
            if end > lead and not cls._split_inside_entity(pending, end):
                candidates.append(end)

        fallback = cls._safe_fallback_boundary(pending)
        if fallback is not None:
            candidates.append(fallback)

        if force:
            candidates.append(len(pending))

        valid = [
            end for end in candidates
            if end > 0 and cls._word_count(pending[:end]) >= 1
        ]
        if not valid:
            return None
        return min(valid)

    @classmethod
    def _split_semantic(cls, text: str, *, force_all: bool = False) -> list[str]:
        chunks: list[str] = []
        remaining = text
        while remaining.strip():
            boundary = cls._next_emit_boundary(remaining, force=force_all)
            if boundary is None:
                tail = remaining.strip()
                if tail:
                    chunks.append(tail)
                break
            chunk = remaining[:boundary].strip()
            remaining = remaining[boundary:].lstrip()
            if chunk:
                chunks.append(chunk)
        return chunks


class TtsSentenceCompleteBuffer:
    """
    Accumulate LLM tokens until a full sentence is ready.

    NEVER emits partial clauses, word splits, or incomplete fragments to TTS.
    """

    def __init__(self) -> None:
        self._raw = ""

    def feed(self, token: str) -> None:
        if token:
            self._raw += token

    @property
    def pending(self) -> str:
        return self._raw

    def drain_complete_sentences(self) -> list[str]:
        """Return only fully terminated sentences — keep remainder buffered."""
        ready: list[str] = []
        while self._raw.strip():
            match = _SENTENCE_SPLIT_RE.search(self._raw)
            if match:
                end = match.start()
                sentence = self._raw[:end].strip()
                self._raw = self._raw[match.end():]
            elif _is_sentence_complete(self._raw):
                sentence = self._raw.strip()
                self._raw = ""
            else:
                break
            if sentence:
                ready.append(sentence)
        return ready

    def flush_remainder(self) -> str:
        """Return trailing text after the LLM stream ends (may be incomplete)."""
        remainder = self._raw.strip()
        self._raw = ""
        return remainder


def llm_streaming_permitted(execution_policy: str) -> bool:
    """Only llm_allowed may stream tokens into the SpeechPacer / scheduler pipeline."""
    return policy_allows_llm(execution_policy)  # type: ignore[arg-type]


async def buffer_llm_response_until_complete(
    on_token_source: Callable[
        [Callable[[str], Awaitable[None]]],
        Awaitable[tuple[str, list[str], list[tuple[str, dict]]]],
    ],
) -> tuple[str, list[str], list[tuple[str, dict]]]:
    """
    Collect the full LLM response — swallow stream tokens, never emit partial speech.

    Use when execution_policy != llm_allowed or streaming must not reach TTS.
    """
    captured: list[str] = []

    async def _swallow_token(token: str) -> None:
        if token:
            captured.append(token)

    final_text, tools_used, tool_results = await on_token_source(_swallow_token)
    merged = (final_text or "").strip()
    if not merged:
        merged = "".join(captured).strip()
    return merged, tools_used, tool_results


# ── Intent commitment layer — single semantic interpretation per user turn ─────

INTENT_COMMITMENT_VERSION = "v1.0"


@dataclass(frozen=True)
class Intent:
    """Immutable committed interpretation for one user turn."""

    locked_workflow: str = ""
    action: str = "brain"
    reason: str = ""
    is_product_search: bool = False
    product_intent_detected: bool = False
    is_order_lookup: bool = False
    is_payment_flow: bool = False
    skip_llm: bool = False
    skip_brain: bool = False
    intent_lock: bool = False
    execution_policy: str = ""
    active_workflow: str = ""
    product_commerce_status: str = ""
    turn_text: str = ""
    turn_mode: str = ""


def clear_committed_intent(session: "SessionState", *, reason: str = "") -> None:
    """Reset committed intent — new user turn or call interruption."""
    if getattr(session, "committed_intent", None) is not None:
        logger.info(
            "committed_intent_cleared sid=%s reason=%s",
            (session.call_sid or "")[:6],
            reason or "unspecified",
        )
    session.committed_intent = None
    session._turn_classification = None  # type: ignore[attr-defined]


def reset_committed_intent_on_interrupt(session: "SessionState") -> None:
    """Called when the caller barges in — discard turn interpretation."""
    clear_committed_intent(session, reason="call_interruption")


def is_intent_committed(session: "SessionState") -> bool:
    return getattr(session, "committed_intent", None) is not None


def _intent_reuse_guard_triggered(
    session: "SessionState",
    source: str,
) -> Optional[ClassificationResult]:
    """
    If committed_intent exists, return it and log — bypass all re-classification.
    """
    committed = get_committed_classification(session)
    if committed is None:
        pending = getattr(session, "_turn_classification", None)
        if pending is not None:
            logger.info(
                "intent_reuse_guard_triggered sid=%s source=%s workflow=%s reason=pending_turn_classification",
                (session.call_sid or "")[:6],
                source,
                pending.locked_workflow or "-",
            )
            return pending
        return None

    logger.info(
        "intent_reuse_guard_triggered sid=%s source=%s workflow=%s",
        (session.call_sid or "")[:6],
        source,
        committed.locked_workflow or "-",
    )
    return committed


def classify_turn_once(
    session: "SessionState",
    caller_text: str,
    *,
    turn_mode: str = "",
    twiml_greeting_already: bool = False,
    source: str = "classify",
) -> ClassificationResult:
    """
    Run fast classifier at most once per user turn.

    After commit_intent() or a prior classify in the same turn, reuses cached intent.
    """
    guarded = _intent_reuse_guard_triggered(session, source)
    if guarded is not None:
        return guarded

    result = classify(
        caller_text,
        session,
        turn_mode=turn_mode,
        twiml_greeting_already=twiml_greeting_already,
    )
    result = apply_product_intent_hard_gate(result, caller_text)
    result = bind_session_intent_lock(session, apply_intent_lock(result))
    session._turn_classification = result  # type: ignore[attr-defined]
    return result


def classification_from_committed_intent(intent: Intent) -> ClassificationResult:
    """Rebuild classifier view from committed intent — no re-evaluation."""
    return ClassificationResult(
        action=intent.action,
        reason=intent.reason,
        skip_llm=intent.skip_llm,
        skip_brain=intent.skip_brain,
        is_product_search=intent.is_product_search,
        product_intent_detected=intent.product_intent_detected,
        is_order_lookup=intent.is_order_lookup,
        is_payment_flow=intent.is_payment_flow,
        intent_lock=intent.intent_lock,
        locked_workflow=intent.locked_workflow,
    )


def get_committed_classification(session: "SessionState") -> Optional[ClassificationResult]:
    intent = getattr(session, "committed_intent", None)
    if intent is None:
        return None
    return classification_from_committed_intent(intent)


def commit_intent(
    session: "SessionState",
    classifier_result: ClassificationResult,
    fsm_state: ExecutionFsmState,
    *,
    active_workflow: str = "",
    execution_policy: str = "",
    turn_text: str = "",
    turn_mode: str = "",
) -> Intent:
    """
  Commit semantic interpretation once per turn — downstream must not re-classify.

    Idempotent: returns existing intent if already committed this turn.
    """
    existing = getattr(session, "committed_intent", None)
    if existing is not None:
        return existing

    intent = Intent(
        locked_workflow=(classifier_result.locked_workflow or "").strip(),
        action=(classifier_result.action or "brain").strip() or "brain",
        reason=(classifier_result.reason or "").strip(),
        is_product_search=bool(classifier_result.is_product_search),
        product_intent_detected=bool(classifier_result.product_intent_detected),
        is_order_lookup=bool(classifier_result.is_order_lookup),
        is_payment_flow=bool(classifier_result.is_payment_flow),
        skip_llm=bool(classifier_result.skip_llm),
        skip_brain=bool(classifier_result.skip_brain),
        intent_lock=bool(classifier_result.intent_lock),
        execution_policy=(execution_policy or "").strip(),
        active_workflow=(active_workflow or "").strip(),
        product_commerce_status=(fsm_state.product_commerce_status or "idle").strip(),
        turn_text=(turn_text or "").strip(),
        turn_mode=(turn_mode or "").strip(),
    )
    session.committed_intent = intent
    logger.info(
        "committed_intent sid=%s workflow=%s policy=%s pcs=%s action=%s",
        (session.call_sid or "")[:6],
        intent.locked_workflow or "-",
        intent.execution_policy or "-",
        intent.product_commerce_status,
        intent.action,
    )
    return intent


def resolve_turn_classification(
    session: "SessionState",
    caller_text: str,
    *,
    turn_mode: str = "",
    twiml_greeting_already: bool = False,
    plan_classification: Optional[ClassificationResult] = None,
    source: str = "resolve_turn_classification",
) -> ClassificationResult:
    """
    Return committed classification or run classifier exactly once for the turn.

    After commit_intent(), never calls classify() again.
    """
    guarded = _intent_reuse_guard_triggered(session, source)
    if guarded is not None:
        return guarded

    if plan_classification is not None:
        result = apply_product_intent_hard_gate(plan_classification, caller_text)
        result = bind_session_intent_lock(session, apply_intent_lock(result))
        session._turn_classification = result  # type: ignore[attr-defined]
        return result

    return classify_turn_once(
        session,
        caller_text,
        turn_mode=turn_mode,
        twiml_greeting_already=twiml_greeting_already,
        source=source,
    )


def enforce_committed_intent_on_classification(
    session: "SessionState",
    classification: ClassificationResult,
    *,
    source: str = "enforce_committed_intent",
) -> ClassificationResult:
    """Prevent mid-turn classification drift — committed intent wins."""
    guarded = _intent_reuse_guard_triggered(session, source)
    if guarded is not None:
        return guarded
    return classification


class VoiceOrchestrator:
    """
    Voice OS control plane inside voice_commerce_runtime.

    Intent routing, state-machine gates, and LLM gate — no duplicate workflows.
    """

    def plan_turn(
        self,
        runtime: "VoiceCommerceRuntime",
        session: "SessionState",
        caller_text: str,
        turn_mode: str,
        *,
        twiml_greeting: bool = False,
    ) -> OrchestratorPlan:
        t0 = time.monotonic()
        conv = runtime._voice_conversation(session)
        prior_stage = conv.get("stage", "idle") or "idle"
        runtime._sync_voice_conversation_state(session, caller_text, turn_mode=turn_mode)
        from ..agent_runtime.workflow_isolation import sync_product_commerce_state

        sync_product_commerce_state(session, caller_text, turn_mode=turn_mode)
        conv = runtime._voice_conversation(session)
        stage = conv.get("stage", "idle") or "idle"
        plan = OrchestratorPlan(stage=stage)

        from ..agent_runtime.order_flow_state import (
            extract_order_number,
            is_actionable_order_number,
            order_intent_detected,
        )
        from ..agent_runtime.workflow_isolation import (
            commerce_handling_allowed,
            order_context_on_call,
            order_handling_allowed,
        )
        from ..agent_runtime.yes_engagement import is_bare_yes

        if stage == "awaiting_order_number" and prior_stage == "awaiting_order_number":
            order_num = extract_order_number(caller_text, session, turn_mode=turn_mode)
            if not (order_num and is_actionable_order_number(order_num)):
                plan.fast_route = "guided_awaiting"
                plan.reason = "stage_awaiting_order_number"
                fsm = build_execution_fsm_state(
                    session, turn_mode=turn_mode, voice_stage=stage,
                )
                apply_execution_policy_to_plan(
                    plan, resolve_execution_policy(session, None, fsm),
                )
                plan.plan_ms = (time.monotonic() - t0) * 1000
                return plan

        if stage == "completed":
            plan.fast_route = "guided_completed"
            plan.reason = "stage_completed"
            fsm = build_execution_fsm_state(
                session, turn_mode=turn_mode, voice_stage=stage,
            )
            apply_execution_policy_to_plan(
                plan, resolve_execution_policy(session, None, fsm),
            )
            plan.plan_ms = (time.monotonic() - t0) * 1000
            return plan

        if is_bare_yes(caller_text) and (
            commerce_handling_allowed(session, turn_mode, caller_text)
            or order_context_on_call(session)
        ):
            plan.fast_route = "yes_engagement"
            plan.reason = "bare_yes_confirmation"
            fsm = build_execution_fsm_state(
                session, turn_mode=turn_mode, voice_stage=stage,
            )
            apply_execution_policy_to_plan(
                plan, resolve_execution_policy(session, None, fsm),
            )
            plan.plan_ms = (time.monotonic() - t0) * 1000
            return plan

        classification = classify_turn_once(
            caller_text,
            session,
            turn_mode=turn_mode,
            twiml_greeting_already=twiml_greeting,
            source="plan_turn",
        )
        plan.classification = classification

        plan = _enforce_plan_intent_lock(
            plan, classification, session, caller_text, turn_mode,
        )

        fsm = build_execution_fsm_state(
            session,
            turn_mode=turn_mode,
            voice_stage=stage,
            brain_gate_active=probe_brain_gate_active(
                session, caller_text, turn_mode=turn_mode,
            ),
            workflow_llm_blocked=_llm_blocked_for_workflow(
                session, caller_text, turn_mode, classification, "",
            ),
        )
        policy = resolve_execution_policy(session, classification, fsm)
        apply_execution_policy_to_plan(plan, policy)
        assign_plan_fast_route_from_policy(
            plan,
            session,
            classification,
            turn_mode=turn_mode,
            policy=policy,
            fsm_state=fsm,
        )

        plan.plan_ms = (time.monotonic() - t0) * 1000
        return plan

    @staticmethod
    def allows_llm(plan: OrchestratorPlan) -> bool:
        """LLM is fallback only — execution policy is the single authority."""
        if plan.execution_policy:
            return policy_allows_llm(plan.execution_policy)  # type: ignore[arg-type]
        if plan.classification:
            if not locked_workflow_allows_llm(plan.classification):
                return False
            if (
                plan.classification.skip_llm
                or plan.classification.skip_brain
                or plan.classification.product_intent_detected
            ):
                return False
        return plan.use_llm


class VoiceCommerceRuntime:
    """Single-brain commerce runtime for live ConversationRelay turns."""

    def __init__(self, settings=None):
        from ..config import get_settings

        self._settings = settings or get_settings()
        self._brain = MainCommerceBrain(self._settings)
        self._orchestrator = VoiceOrchestrator()

    @staticmethod
    def _voice_conversation(session: "SessionState") -> dict:
        conv = getattr(session, "voice_conversation", None)
        if not isinstance(conv, dict):
            conv = {"stage": "idle", "last_intent": "", "last_order_id": None}
            session.voice_conversation = conv
        return conv

    def _sync_voice_conversation_state(
        self,
        session: "SessionState",
        caller_text: str,
        *,
        turn_mode: str = "",
    ) -> None:
        """Track guided order conversation stage on the live session."""
        from ..agent_runtime.order_flow_state import (
            extract_order_number,
            is_actionable_order_number,
            order_intent_detected,
        )

        conv = self._voice_conversation(session)
        text = (caller_text or "").strip()
        if not text:
            return

        order_num = extract_order_number(text, session, turn_mode=turn_mode)
        has_num = bool(order_num and is_actionable_order_number(order_num))

        if order_intent_detected(text):
            conv["last_intent"] = "order_lookup"
            if not has_num and not (getattr(session, "order_last_voice_reply", "") or "").strip():
                conv["stage"] = "awaiting_order_number"

        if has_num:
            conv["last_order_id"] = order_num.lstrip("#")
            if conv.get("stage") in ("idle", "awaiting_order_number"):
                conv["stage"] = "order_lookup"
            return

        from ..agent_runtime.workflow_isolation import (
            PCS_IDLE,
            product_commerce_status,
            sync_product_commerce_state,
        )

        sync_product_commerce_state(session, text, turn_mode=turn_mode)
        pcs = product_commerce_status(session)
        if pcs != PCS_IDLE:
            conv["stage"] = pcs
            conv["last_intent"] = "product_commerce"

    @staticmethod
    def _mark_voice_conversation_completed(session: "SessionState") -> None:
        conv = VoiceCommerceRuntime._voice_conversation(session)
        conv["stage"] = "completed"
        if not conv.get("last_order_id"):
            last = (getattr(session, "last_order_number", "") or "").strip().lstrip("#")
            if last:
                conv["last_order_id"] = last

    def _enforce_awaiting_order_ux(
        self,
        session: "SessionState",
        caller_text: str,
        *,
        turn_mode: str = "",
    ) -> Optional[str]:
        """When collecting an order number, only allow the guided prompt."""
        from ..agent_runtime.order_flow_state import (
            extract_order_number,
            is_actionable_order_number,
        )

        conv = self._voice_conversation(session)
        if conv.get("stage") != "awaiting_order_number":
            return None

        order_num = extract_order_number(caller_text, session, turn_mode=turn_mode)
        if order_num and is_actionable_order_number(order_num):
            conv["stage"] = "order_lookup"
            conv["last_order_id"] = order_num.lstrip("#")
            return None
        return _GUIDED_AWAITING_ORDER_PROMPT

    async def _try_guided_completed_turn(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable,
        *,
        turn_mode: str = "",
    ) -> Optional[RuntimeTurnResult]:
        """After order lookup, replay summary only — no open-ended chat."""
        from ..agent_runtime.order_flow_state import (
            extract_order_number,
            is_actionable_order_number,
            order_intent_detected,
            try_order_followup_reply,
        )

        conv = self._voice_conversation(session)
        if conv.get("stage") != "completed":
            return None

        summary = (getattr(session, "order_last_voice_reply", "") or "").strip()
        if not summary:
            conv["stage"] = "idle"
            return None

        order_num = extract_order_number(caller_text, session, turn_mode=turn_mode)
        if order_num and is_actionable_order_number(order_num):
            conv["stage"] = "order_lookup"
            conv["last_order_id"] = order_num.lstrip("#")
            return None

        if order_intent_detected(caller_text) and not order_num:
            conv["stage"] = "awaiting_order_number"
            conv["last_intent"] = "order_lookup"
            spoken = await self._speak(
                session, caller_text, _GUIDED_AWAITING_ORDER_PROMPT, send,
            )
            return _result(spoken)

        followup = try_order_followup_reply(session, caller_text)
        if followup:
            spoken = self._brain.finalize_response(session, followup, [])
            spoken = await self._speak(
                session, caller_text, spoken, send, interruptible=False,
            )
            return _result(spoken)

        spoken = await self._speak(
            session, caller_text, summary, send, interruptible=False,
        )
        return _result(spoken)

    def _build_live_context(
        self,
        session: "SessionState",
        caller_text: str,
        *,
        turn_mode: str = "",
        caller_context: Optional["SafeCallerContext"] = None,
    ) -> str:
        """LLM context is sandboxed in MainCommerceBrain — no workflow state injection."""
        return ""

    async def _route_product_search_once(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable,
        *,
        turn_mode: str = "",
        classification: ClassificationResult,
        sid: str,
    ) -> Optional[RuntimeTurnResult]:
        """Single per-turn dispatch into execute_product_search_workflow()."""
        from ..agent_runtime.workflow_contracts import (
            WorkflowViolationError,
            register_product_search_router_invocation,
        )

        if getattr(session, "_product_search_routed_this_turn", False):
            raise WorkflowViolationError("MULTI_ROUTER_DETECTED")
        register_product_search_router_invocation()
        session._product_search_routed_this_turn = True  # type: ignore[attr-defined]
        return await self.route_to_product_search_workflow(
            session,
            caller_text,
            send,
            turn_mode=turn_mode,
            classification=classification,
            sid=sid,
        )

    async def route_to_product_search_workflow(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable,
        *,
        turn_mode: str = "",
        classification: ClassificationResult,
        sid: str,
    ) -> Optional[RuntimeTurnResult]:
        """
        Single runtime entry for product_search_workflow.

        Delegates to execute_product_search_workflow() — no legacy hunt pipelines.
        """
        from ..agent_runtime.commerce_flow_state import enforce_commerce_response
        from ..agent_runtime.voice_workflows import execute_product_search_workflow
        from ..agent_runtime.workflow_contracts import WorkflowViolationError

        try:
            result = await execute_product_search_workflow(
                session,
                caller_text,
                turn_mode=turn_mode,
                classification=classification,
            )
        except WorkflowViolationError:
            raise
        except Exception as exc:
            logger.warning(
                "product_search_workflow_failed sid=%s err=%s",
                sid,
                type(exc).__name__,
            )
            spoken = self._brain.finalize_response(session, _OPENAI_FALLBACK, [])
            spoken = await self._speak(session, caller_text, spoken, send)
            return _result(spoken)

        if not result or not result.force_reply:
            return None

        if result.catalog_not_found_escalation:
            return await self._handle_catalog_not_found_fallback(
                session,
                caller_text,
                send,
                force_reply=result.force_reply,
                sid=sid,
            )

        record_commerce_voice_reply(session, result.force_reply)
        spoken = enforce_commerce_response(
            session,
            self._brain.finalize_response(
                session, result.force_reply, result.tool_results or [],
            ),
            result.tool_results or [],
        )
        spoken = await self._speak(session, caller_text, spoken, send)
        logger.info(
            "product_search_workflow sid=%s route=%s isbn=%s",
            sid,
            result.route or "-",
            (result.isbn or "")[:13],
        )
        return _result(spoken)

    async def _handle_escalation_loop_forced(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable,
        *,
        turn_mode: str = "",
        sid: str,
        guard_result,
    ) -> RuntimeTurnResult:
        """Break infinite workflow loops — force support handoff, no retries, no LLM."""
        from ..agent_runtime.workflow_contracts import SUPPORT_HANDOFF_WORKFLOW

        reply = guard_result.forced_reply or ""
        if guard_result.domain == SUPPORT_HANDOFF_WORKFLOW:
            spoken = await self._speak_support_handoff_reply(
                session, caller_text, reply, send,
            )
            logger.info(
                "escalation_loop_terminal sid=%s stage=%s count=%d",
                sid,
                guard_result.stage,
                guard_result.repeat_count,
            )
            return _result(spoken)

        handoff = await self._route_support_handoff_workflow(
            session, caller_text, send, turn_mode=turn_mode, sid=sid,
        )
        if handoff is not None:
            return handoff

        spoken = await self._speak_support_handoff_reply(
            session, caller_text, reply, send,
        )
        logger.info(
            "escalation_loop_forced_handoff sid=%s domain=%s stage=%s count=%d",
            sid,
            guard_result.domain,
            guard_result.stage,
            guard_result.repeat_count,
        )
        return _result(spoken)

    async def _route_support_handoff_workflow(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable,
        *,
        turn_mode: str = "",
        sid: str,
    ) -> Optional[RuntimeTurnResult]:
        """Single entry point for support_handoff_workflow."""
        from ..agent_runtime.voice_workflows import execute_support_handoff_workflow

        await prepare_critical_voice_action(session, action="support_escalation")

        esc_hint = await execute_support_handoff_workflow(
            session, caller_text, turn_mode=turn_mode,
        )
        if esc_hint and (esc_hint.force_reply or esc_hint.deliver_email_spell_readback):
            spoken = await self._speak_support_handoff_reply(
                session,
                caller_text,
                esc_hint.force_reply or "",
                send,
                deliver_email_spell_readback=esc_hint.deliver_email_spell_readback,
            )
            logger.info("support_handoff_workflow sid=%s", sid)
            return _result(spoken)
        return None

    async def _product_clarification_turn(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable,
        *,
        turn_mode: str = "",
        classification: Optional[ClassificationResult] = None,
    ) -> RuntimeTurnResult:
        """Step 2 — one clarification question, no catalog search or LLM."""
        from ..agent_runtime.voice_workflows import _clear_partial_isbn_collection

        if has_valid_product_identifier(session, caller_text, turn_mode):
            if not getattr(session, "_product_search_routed_this_turn", False):
                if classification is None:
                    classification = _intent_reuse_guard_triggered(
                        session, "product_clarification_turn",
                    )
                if classification is None:
                    logger.warning(
                        "product_clarification_missing_commit sid=%s",
                        (session.call_sid or "")[:6],
                    )
                else:
                    sid = (session.call_sid or "")[:6]
                    routed = await self._route_product_search_once(
                        session,
                        caller_text,
                        send,
                        turn_mode=turn_mode,
                        classification=classification,
                        sid=sid,
                    )
                    if routed is not None:
                        return routed
        _clear_partial_isbn_collection(session)
        spoken = await self._speak(
            session,
            caller_text,
            _PRODUCT_CLARIFICATION_REPLY,
            send,
        )
        return _result(spoken)

    async def _handle_email_fsm(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable,
        *,
        turn_mode: str = "",
    ) -> Optional[RuntimeTurnResult]:
        """Payment checkout email — single process_payment_turn pipeline."""
        await prepare_critical_voice_action(session, action="email_capture")

        payment_hint = process_payment_turn(session, caller_text, turn_mode=turn_mode)
        if payment_hint.force_reply or payment_hint.deliver_email_spell_readback:
            from ..email.speller import is_preserved_email_readback
            from ..payment.email_state import get_pending_payment_email

            reply = payment_hint.force_reply or ""
            if reply:
                record_payment_voice_reply(session, reply)
            pending = get_pending_payment_email(session)
            if payment_hint.deliver_email_spell_readback and pending:
                spoken = await self._speak_email_readback_text(
                    session, caller_text, reply, send,
                )
            elif is_preserved_email_readback(reply) and pending:
                spoken = await self._speak_email_readback_text(
                    session, caller_text, reply, send,
                )
            else:
                spoken = await self._speak(session, caller_text, reply, send)
            logger.info("payment_email_workflow sid=%s", session.call_sid[:6])
            return _result(spoken)

        if payment_hint.email_confirmed and PAYMENT_AUTO_SEND_ENABLED:
            return await self._auto_send_payment(session, caller_text, send)

        if needs_deferred_payment_auto_send(session) and PAYMENT_AUTO_SEND_ENABLED:
            return await self._auto_send_payment(session, caller_text, send)

        return None

    async def _auto_send_payment(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable,
    ) -> RuntimeTurnResult:
        from ..agent_runtime import llm_tools
        from ..agent_runtime.payment_flow_state import parse_tool_result
        from ..payment.payment_link_service import PAYMENT_PROGRESS_MESSAGE

        sid = session.call_sid[:6]
        await ensure_email_spell_inactive_before_payment(session)
        await flush_voice_queue_before_critical_action(session)

        await schedule_voice_output(
            session,
            PAYMENT_PROGRESS_MESSAGE,
            VOICE_PRIORITY_PAYMENT_LINK,
            send=send,
            interruptible=False,
        )
        await wait_for_speech_completion_before_next_action(session)

        raw = await llm_tools.dispatch("send_payment_link", {}, session)
        parsed = parse_tool_result(raw)
        spoken = enforce_payment_response(
            session,
            parsed.get("customer_message") or "I sent the payment link to your email. Please check your inbox.",
            [("send_payment_link", parsed)],
        )
        record_payment_voice_reply(session, spoken)
        from ..dialogue.call_closure import mark_awaiting_anything_else, offer_anything_else_suffix

        if parsed.get("email_sent"):
            mark_awaiting_anything_else(session)
            if offer_anything_else_suffix().strip() not in spoken:
                spoken = f"{spoken.rstrip('.')}.{offer_anything_else_suffix()}"
        spoken = await self._speak_payment_link(session, caller_text, spoken, send)
        await wait_for_speech_completion_before_next_action(session)
        logger.info("payment_auto_send sid=%s success=%s", sid, bool(parsed.get("email_sent")))
        return _result(spoken)

    @staticmethod
    def _apply_voice_output_pipeline(
        spoken: str,
        session: Optional["SessionState"] = None,
        *,
        user_text: str = "",
    ) -> str:
        """Voice Output Contract → VoiceResponseFormatter. Single TTS prep path."""
        from ..voice.voice_output_contract import enforce_voice_output_contract
        from ..voice.voice_response_formatter import format_voice_response

        contract = enforce_voice_output_contract(spoken)
        return format_voice_response(
            contract.content,
            session,
            user_text=user_text,
        ).speech_text

    @staticmethod
    def _format_for_tts(
        spoken: str,
        session: Optional["SessionState"] = None,
        *,
        user_text: str = "",
    ) -> str:
        """Single TTS gate — all spoken text passes through finalize_voice_output."""
        return finalize_voice_output(
            spoken, session, user_text=user_text, allow_short=True,
        )

    @staticmethod
    def _format_stream_chunk(
        spoken: str,
        session: Optional["SessionState"] = None,
        *,
        user_text: str = "",
    ) -> str:
        """Streaming chunks require complete sentences — never partial LLM tokens."""
        return finalize_voice_output(
            spoken,
            session,
            user_text=user_text,
            log_metrics=False,
            require_complete=True,
            allow_short=False,
        )

    @staticmethod
    def _enforce_llm_voice_contract(raw_llm_text: str) -> str:
        """Force LLM output into voice contract content before guardrails/formatting."""
        from ..voice.voice_output_contract import enforce_voice_output_contract

        contract = enforce_voice_output_contract(raw_llm_text or "")
        return contract.content

    async def _handle_catalog_not_found_fallback(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable,
        *,
        force_reply: str,
        sid: str,
    ) -> RuntimeTurnResult:
        """
        Deterministic catalog miss escalation — no LLM, no retry loops.

        Stages existing support_handoff_workflow; email capture runs on later turns.
        """
        from ..agent_runtime.commerce_flow_state import record_commerce_voice_reply

        reply = (force_reply or "").strip()
        if not reply:
            return None  # type: ignore[return-value]

        await prepare_critical_voice_action(session, action="support_escalation")

        record_commerce_voice_reply(session, reply)
        spoken = self._format_for_tts(reply, session, user_text=caller_text)
        spoken = await self._speak(
            session, caller_text, spoken, send, interruptible=False,
        )
        logger.info(
            "catalog_not_found_fallback_escalation sid=%s awaiting_email=%s",
            sid,
            bool(getattr(session, "awaiting_not_found_escalation_email", False)),
        )
        return _result(spoken)

    def _resolve_turn_execution_policy(
        self,
        session: "SessionState",
        caller_text: str,
        turn_mode: str,
        classification: ClassificationResult,
        plan: OrchestratorPlan,
        active_workflow: str,
    ) -> tuple[str, object]:
        """Single policy resolution for the turn — feeds all LLM routing."""
        classification = enforce_committed_intent_on_classification(
            session, classification, source="resolve_turn_execution_policy",
        )
        conv = self._voice_conversation(session)
        workflow_blocked = _llm_blocked_for_workflow(
            session, caller_text, turn_mode, classification, active_workflow,
        )
        fsm = build_execution_fsm_state(
            session,
            turn_mode=turn_mode,
            voice_stage=conv.get("stage", "idle") or "idle",
            brain_gate_active=probe_brain_gate_active(
                session, caller_text, turn_mode=turn_mode,
            ),
            active_workflow=active_workflow,
            workflow_llm_blocked=workflow_blocked,
        )
        policy = resolve_execution_policy(session, classification, fsm)
        apply_execution_policy_to_plan(plan, policy)
        return policy, fsm

    async def _speak_brain_gate_reply(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable,
        *,
        turn_mode: str = "",
        sid: str = "",
    ) -> Optional[RuntimeTurnResult]:
        """Short-circuit path — replay deterministic copy from legacy brain gates."""
        gate = resolve_brain_gate_reply(session, caller_text, turn_mode=turn_mode)
        if not gate:
            return None
        reply, gate_name = gate
        if gate_name == "commerce":
            record_commerce_voice_reply(session, reply)
        elif gate_name == "payment":
            record_payment_voice_reply(session, reply)
            from ..payment.email_state import get_pending_payment_email

            pending = get_pending_payment_email(session)
            if pending and getattr(session, "awaiting_payment_email_confirmation", False):
                await flush_voice_queue_before_critical_action(session)
                spoken = await self._speak_email_readback_text(
                    session, caller_text, reply, send,
                )
                logger.info("%s_brain_gate sid=%s spell_readback=true", gate_name, sid)
                return _result(spoken)
        spoken = self._brain.finalize_response(session, reply, [])
        spoken = await self._speak(
            session, caller_text, spoken, send, interruptible=False,
        )
        logger.info("%s_brain_gate sid=%s", gate_name, sid)
        return _result(spoken)

    async def _route_non_llm_execution_policy(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable,
        *,
        turn_mode: str = "",
        classification: ClassificationResult,
        plan: OrchestratorPlan,
        active_workflow: str,
        execution_policy: str,
        fsm: object,
        sid: str = "",
    ) -> Optional[RuntimeTurnResult]:
        """Deterministic + short_circuit template handlers — never the LLM pipeline."""
        if policy_allows_llm(execution_policy):  # type: ignore[arg-type]
            return None

        from ..agent_runtime.workflow_isolation import (
            commerce_handling_allowed,
            support_handling_allowed,
        )
        from ..runtime.fast_classifier import locked_workflow_requires_product_search

        if commerce_handling_allowed(session, turn_mode, caller_text):
            cart_sc = await self._handle_product_cart_short_circuit(
                session, caller_text, send, turn_mode=turn_mode, sid=sid,
            )
            if cart_sc is not None:
                return cart_sc

        if support_handling_allowed(session, turn_mode, caller_text):
            handoff = await self._route_support_handoff_workflow(
                session, caller_text, send, turn_mode=turn_mode, sid=sid,
            )
            if handoff is not None:
                return handoff

        if requires_product_clarification_before_brain(
            session, caller_text, turn_mode,
        ) and locked_workflow_requires_product_search(classification):
            logger.info("product_clarification_pre_brain sid=%s", sid)
            return await self._product_clarification_turn(
                session,
                caller_text,
                send,
                turn_mode=turn_mode,
                classification=classification,
            )

        if locked_workflow_requires_product_search(classification):
            if not getattr(session, "_product_search_routed_this_turn", False):
                product_locked = await self._route_product_search_once(
                    session,
                    caller_text,
                    send,
                    turn_mode=turn_mode,
                    classification=classification,
                    sid=sid,
                )
                if product_locked is not None:
                    return product_locked
            return await self._product_clarification_turn(
                session,
                caller_text,
                send,
                turn_mode=turn_mode,
                classification=classification,
            )

        workflow_blocked = getattr(fsm, "workflow_llm_blocked", False)
        if workflow_blocked or execution_policy in (
            EXECUTION_POLICY_DETERMINISTIC,
            EXECUTION_POLICY_SHORT_CIRCUIT,
        ):
            logger.info(
                "workflow_llm_gate sid=%s workflow=%s policy=%s",
                sid,
                active_workflow or "-",
                execution_policy,
            )
            return await self._product_clarification_turn(
                session,
                caller_text,
                send,
                turn_mode=turn_mode,
                classification=classification,
            )

        spoken = _STUCK_RECOVERY
        spoken = await self._speak(session, caller_text, spoken, send)
        logger.info(
            "voice_orchestrator_llm_skipped sid=%s policy=%s reason=%s route=%s",
            sid,
            plan.execution_policy or "-",
            plan.reason,
            plan.fast_route or "-",
        )
        return _result(spoken)

    async def _handle_product_cart_short_circuit(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable,
        *,
        turn_mode: str = "",
        sid: str = "",
    ) -> Optional[RuntimeTurnResult]:
        """Deterministic cart add — classifier + templates only (no LLM)."""
        from ..agent_runtime.commerce_flow_state import (
            enforce_commerce_response,
            record_commerce_voice_reply,
            try_product_cart_short_circuit,
        )

        cart_hint = try_product_cart_short_circuit(
            session, caller_text, turn_mode=turn_mode,
        )
        if not cart_hint or not cart_hint.force_reply:
            return None
        record_commerce_voice_reply(session, cart_hint.force_reply)
        if cart_hint.book_added:
            self._sync_session_cart_memory(session)
        spoken = enforce_commerce_response(
            session,
            self._brain.finalize_response(session, cart_hint.force_reply, []),
            [],
        )
        spoken = await self._speak_cart(
            session, caller_text, spoken, send, sid=sid,
        )
        logger.info(
            "product_cart_short_circuit sid=%s book_added=%s skipped=%s",
            sid,
            cart_hint.book_added,
            cart_hint.openai_skipped,
        )
        return _result(spoken)

    async def _handle_payment_checkout_short_circuit(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable,
        *,
        turn_mode: str = "",
        sid: str = "",
    ) -> Optional[RuntimeTurnResult]:
        """Deterministic checkout/payment — session cart invoice + Shopify tool only."""
        from ..agent_runtime.payment_flow_state import (
            PAYMENT_FAILURE_MESSAGE,
            PAYMENT_LINK_VOICE_TEMPLATE,
            record_payment_voice_reply,
            try_payment_checkout_short_circuit,
        )
        from ..payment.payment_link_service import send_confirmed_payment_link

        hint = try_payment_checkout_short_circuit(
            session, caller_text, turn_mode=turn_mode,
        )
        if not hint or not hint.force_reply:
            return None

        await ensure_email_spell_inactive_before_payment(session)
        await prepare_critical_voice_action(session, action="checkout")

        if hint.blocked_duplicate or not hint.send_payment_link:
            record_payment_voice_reply(session, hint.force_reply)
            spoken = self._brain.finalize_response(session, hint.force_reply, [])
            spoken = await self._speak_payment_link(session, caller_text, spoken, send)
            logger.info(
                "payment_checkout_short_circuit sid=%s duplicate=%s",
                sid,
                hint.blocked_duplicate,
            )
            return _result(spoken)

        parsed = await send_confirmed_payment_link(
            session,
            items=hint.checkout_items,
        )

        if parsed.get("success") and parsed.get("email_sent"):
            spoken = PAYMENT_LINK_VOICE_TEMPLATE
            from ..dialogue.call_closure import mark_awaiting_anything_else

            mark_awaiting_anything_else(session)
        else:
            spoken = parsed.get("customer_message") or PAYMENT_FAILURE_MESSAGE

        record_payment_voice_reply(session, spoken)
        spoken = self._brain.finalize_response(session, spoken, [])
        spoken = await self._speak_payment_link(session, caller_text, spoken, send)
        await wait_for_speech_completion_before_next_action(session)
        logger.info(
            "payment_checkout_send sid=%s success=%s email_sent=%s items=%d",
            sid,
            parsed.get("success"),
            parsed.get("email_sent"),
            len(hint.checkout_items),
        )
        return _result(spoken)

    async def _speak_support_handoff_reply(
        self,
        session: "SessionState",
        caller_text: str,
        reply: str,
        send: Callable,
        *,
        deliver_email_spell_readback: bool = False,
    ) -> str:
        """Support handoff — paced email spell readback when email was just captured."""
        from ..email.speller import is_preserved_email_readback

        pending_esc = getattr(session, "pending_not_found_escalation", None) or {}
        staging = ""
        if isinstance(pending_esc, dict):
            staging = (pending_esc.get("staging_email") or "").strip().lower()
        if deliver_email_spell_readback or (
            is_preserved_email_readback(reply) and staging
        ):
            return await self._speak_email_readback_text(
                session, caller_text, reply, send,
            )
        spoken = self._brain.finalize_response(session, reply, [])
        return await self._speak(session, caller_text, spoken, send)

    async def _speak_email_readback_text(
        self,
        session: "SessionState",
        caller_text: str,
        full_text: str,
        send: Callable,
    ) -> str:
        """Deliver letter-by-letter readback in paced chunks for clear TTS."""
        from ..email.speller import build_email_readback_parts
        from ..payment.email_state import get_pending_payment_email

        await flush_voice_queue_before_critical_action(session)

        email = get_pending_payment_email(session) or ""
        pending_esc = getattr(session, "pending_not_found_escalation", None) or {}
        if not email and isinstance(pending_esc, dict):
            email = (pending_esc.get("staging_email") or "").strip().lower()

        parts = build_email_readback_parts(email, caller_text) if email else [full_text]
        session.history.append({"role": "user", "content": caller_text})
        non_empty = [p.strip() for p in parts if p.strip()]
        session._email_spell_emission_active = True  # type: ignore[attr-defined]
        try:
            for part in non_empty:
                await schedule_voice_output(
                    session,
                    part,
                    VOICE_PRIORITY_EMAIL_SPELL,
                    send=send,
                    user_text=caller_text,
                    interruptible=False,
                    play_immediately=True,
                    send_last=True,
                    already_finalized=False,
                    allow_short=True,
                    log_metrics=False,
                    require_complete=False,
                )
            await wait_for_speech_completion_before_next_action(session)
        finally:
            session._email_spell_emission_active = False  # type: ignore[attr-defined]
        combined = " ".join(non_empty)
        session.history.append({"role": "assistant", "content": combined})
        self._record_turn(session, caller_text, combined)
        return combined

    async def _emit_stream_speech_chunks(
        self,
        session: "SessionState",
        send: Callable,
        chunks: list[str],
        *,
        user_text: str = "",
        interruptible: bool = True,
    ) -> list[str]:
        """Deliver formatted chunks through play_immediately TTS (interrupt-safe)."""
        emitted: list[str] = []
        for chunk in chunks:
            if getattr(session, "voice_interrupted", False):
                break
            formatted = self._format_stream_chunk(chunk, session, user_text=user_text)
            if not formatted:
                continue
            emitted.append(formatted)
            await schedule_voice_output(
                session,
                formatted,
                priority=0,
                send=send,
                interruptible=interruptible,
                play_immediately=True,
                send_last=False,
                already_finalized=True,
            )
        return emitted

    async def _speak_streaming_llm(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable,
        *,
        on_token_source: Callable[[Callable[[str], Awaitable[None]]], Awaitable[tuple[str, list, list]]],
        interruptible: bool = True,
        execution_policy: str = "llm_allowed",
    ) -> tuple[str, list[str], list[tuple[str, dict]], list[str]]:
        """
        Stream LLM tokens to TTS only when execution_policy is llm_allowed.

        Otherwise buffer the full response — no partial product/cart speech.
        """
        if not llm_streaming_permitted(execution_policy):
            final_text, tools_used, tool_results = await buffer_llm_response_until_complete(
                on_token_source,
            )
            return final_text, tools_used, tool_results, []

        buffer = TtsSentenceCompleteBuffer()
        spoken_parts: list[str] = []

        async def on_token(token: str) -> None:
            if getattr(session, "voice_interrupted", False):
                return
            buffer.feed(token)
            complete_sentences = buffer.drain_complete_sentences()
            if not complete_sentences:
                return
            new_chunks = await self._emit_stream_speech_chunks(
                session, send, complete_sentences,
                user_text=caller_text,
                interruptible=interruptible,
            )
            spoken_parts.extend(new_chunks)

        final_text, tools_used, tool_results = await on_token_source(on_token)

        if not getattr(session, "voice_interrupted", False):
            remainder = buffer.flush_remainder()
            if remainder.strip():
                completed = _predict_sentence_end(
                    _merge_incomplete_sentences(
                        remainder,
                        pending_fragment=str(
                            getattr(session, "_tts_pending_fragment", "") or "",
                        ),
                        last_valid_sentence=str(
                            getattr(session, "_tts_last_valid_sentence", "") or "",
                        ),
                    ),
                )
                if completed.strip():
                    tail_chunks = await self._emit_stream_speech_chunks(
                        session, send, [completed],
                        user_text=caller_text,
                        interruptible=interruptible,
                    )
                    spoken_parts.extend(tail_chunks)
            if spoken_parts:
                await schedule_voice_output(
                    session,
                    "",
                    priority=0,
                    send=send,
                    stream_end=True,
                )

        return final_text, tools_used, tool_results, spoken_parts

    async def _speak(
        self,
        session: "SessionState",
        caller_text: str,
        spoken: str,
        send: Callable,
        *,
        interruptible: bool = True,
        skip_user_history: bool = False,
        priority: int = 0,
    ) -> str:
        if getattr(session, "voice_interrupted", False):
            session.is_speaking = False
            return finalize_voice_output(
                spoken, session, user_text=caller_text, allow_short=True,
            )
        if not skip_user_history:
            session.history.append({"role": "user", "content": caller_text})
        tts_text = await schedule_voice_output(
            session,
            spoken,
            priority,
            send=send,
            user_text=caller_text,
            interruptible=interruptible,
        )
        if tts_text:
            session.history.append({"role": "assistant", "content": tts_text})
            self._record_turn(session, caller_text, tts_text)
        return tts_text

    async def _speak_cart(
        self,
        session: "SessionState",
        caller_text: str,
        spoken: str,
        send: Callable,
        *,
        sid: str = "",
    ) -> str:
        """Cart add / quantity confirm — serialized, non-interruptible queue lane."""
        await wait_for_speech_completion_before_next_action(session)
        tts = await self._speak(
            session,
            caller_text,
            spoken,
            send,
            interruptible=False,
            priority=VOICE_PRIORITY_CART,
        )
        if sid:
            logger.info("cart_voice_emitted sid=%s", sid)
        return tts

    async def _speak_payment_link(
        self,
        session: "SessionState",
        caller_text: str,
        spoken: str,
        send: Callable,
    ) -> str:
        """Payment link copy — never overlaps email spelling."""
        await ensure_email_spell_inactive_before_payment(session)
        await wait_for_speech_completion_before_next_action(session)
        return await self._speak(
            session,
            caller_text,
            spoken,
            send,
            interruptible=False,
            priority=VOICE_PRIORITY_PAYMENT_LINK,
        )

    async def handle_turn(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable[[dict], Awaitable[None]],
        caller_context: Optional["SafeCallerContext"] = None,
        turn=None,
        *,
        assembled_turn_mode: str = "",
        stt_to_turn_ms: float = 0.0,
    ) -> RuntimeTurnResult:
        with cart_memory_runtime_scope():
            return await self._handle_turn_inner(
                session,
                caller_text,
                send,
                caller_context=caller_context,
                turn=turn,
                assembled_turn_mode=assembled_turn_mode,
                stt_to_turn_ms=stt_to_turn_ms,
            )

    @staticmethod
    def _sync_session_cart_memory(session: "SessionState") -> None:
        """Keep session CartMemory aligned with confirmed CartLedger lines."""
        try:
            sync_cart_memory_from_ledger(session)
        except Exception:  # noqa: BLE001
            pass

    async def _handle_turn_inner(
        self,
        session: "SessionState",
        caller_text: str,
        send: Callable[[dict], Awaitable[None]],
        caller_context: Optional["SafeCallerContext"] = None,
        turn=None,
        *,
        assembled_turn_mode: str = "",
        stt_to_turn_ms: float = 0.0,
    ) -> RuntimeTurnResult:
        sid = (session.call_sid or "")[:6]
        t0 = time.monotonic()
        turn_mode = assembled_turn_mode or getattr(turn, "mode", "") or ""
        normalized = normalize_speech_text(caller_text)
        session._active_voice_send = send  # type: ignore[attr-defined]

        logger.info(
            "voice_commerce_start sid=%s turn_mode=%s text=%r",
            sid,
            turn_mode or "normal",
            normalized[:60],
        )

        if not getattr(self._settings, "OPENAI_API_KEY", ""):
            spoken = _OPENAI_FALLBACK
            spoken = await self._speak(session, normalized, spoken, send)
            return _result(spoken)

        session._current_turn_mode = turn_mode  # type: ignore[attr-defined]
        session._current_caller_text = normalized  # type: ignore[attr-defined]

        from ..agent_runtime.workflow_contracts import clear_turn_workflow_contract

        clear_turn_workflow_contract(session)
        clear_committed_intent(session, reason="new_user_turn")
        clear_tts_sentence_cache(session)

        from ..agent_runtime.workflow_isolation import (
            WORKFLOW_ISOLATION_VERSION,
            commerce_handling_allowed,
            commerce_silent_advance_allowed,
            isolate_workflow_buffers,
            order_handling_allowed,
            payment_handling_allowed,
            product_handling_allowed,
            product_commerce_status,
            support_handling_allowed,
            sync_product_commerce_state,
        )

        active_workflow = isolate_workflow_buffers(session, turn_mode, normalized)
        sync_product_commerce_state(session, normalized, turn_mode=turn_mode)
        from ..agent_runtime.workflow_contracts import (
            CANONICAL_WORKFLOW_DOMAINS,
            apply_turn_workflow_contract,
        )

        apply_turn_workflow_contract(session, active_workflow)
        logger.info(
            "workflow_isolation sid=%s workflow=%s pcs=%s version=%s",
            sid,
            active_workflow,
            product_commerce_status(session),
            WORKFLOW_ISOLATION_VERSION,
        )

        from ..agent_runtime.workflow_compiler import (
            WorkflowCompileRuntimeViolation,
            assert_runtime_compliance,
            resolve_turn_entry_node,
        )

        if active_workflow in CANONICAL_WORKFLOW_DOMAINS:
            try:
                entry_node = resolve_turn_entry_node(
                    active_workflow,
                    turn_mode=turn_mode,
                )
                assert_runtime_compliance(active_workflow, entry_node)
            except WorkflowCompileRuntimeViolation:
                spoken = self._brain.finalize_response(session, _STUCK_RECOVERY, [])
                spoken = await self._speak(session, normalized, spoken, send)
                return _result(spoken)

        from ..agent_runtime.escalation_guard import EscalationGuard

        if active_workflow in CANONICAL_WORKFLOW_DOMAINS:
            guard_result = EscalationGuard.check_turn(
                session,
                active_workflow,
                normalized,
                turn_mode=turn_mode,
            )
            if guard_result.loop_detected:
                return await self._handle_escalation_loop_forced(
                    session,
                    normalized,
                    send,
                    turn_mode=turn_mode,
                    sid=sid,
                    guard_result=guard_result,
                )

        if commerce_silent_advance_allowed(session, turn_mode, normalized):
            advance_commerce_state_silent(session, normalized)

        from ..dialogue.call_closure import process_call_closure_turn

        closure = process_call_closure_turn(session, normalized)
        if closure is not None:
            spoken = self._brain.finalize_response(session, closure.reply, [])
            spoken = await self._speak(session, normalized, spoken, send)
            return _result(spoken, end_call=closure.end_call)

        from ..payment.payment_state_machine import payment_email_turn_priority

        if support_handling_allowed(session, turn_mode, normalized):
            handoff = await self._route_support_handoff_workflow(
                session, normalized, send, turn_mode=turn_mode, sid=sid,
            )
            if handoff is not None:
                return handoff

        if payment_handling_allowed(session, turn_mode, normalized) or payment_email_turn_priority(
            session, turn_mode,
        ):
            payment_hold = try_payment_hold_reply(session, normalized)
            if payment_hold:
                spoken = await self._speak(session, normalized, payment_hold, send)
                logger.info("payment_hold_short_circuit sid=%s", sid)
                return _result(spoken)

            payment_repeat = try_payment_repeat_reply(session, normalized)
            if payment_repeat:
                spoken = await self._speak(session, normalized, payment_repeat, send)
                logger.info("payment_repeat_short_circuit sid=%s", sid)
                return _result(spoken)

            email_early = await self._handle_email_fsm(
                session, normalized, send, turn_mode=turn_mode,
            )
            if email_early is not None:
                return email_early

        guided_completed = await self._try_guided_completed_turn(
            session, normalized, send, turn_mode=turn_mode,
        )
        if guided_completed is not None:
            logger.info("guided_completed_turn sid=%s", sid)
            return guided_completed

        twiml_greeting = bool(getattr(session, "twiml_greeting_spoken", False))
        plan = self._orchestrator.plan_turn(
            self, session, normalized, turn_mode, twiml_greeting=twiml_greeting,
        )
        logger.info(
            "voice_orchestrator_plan sid=%s policy=%s use_llm=%s stage=%s route=%s reason=%s ms=%.1f",
            sid,
            plan.execution_policy or "-",
            plan.use_llm,
            plan.stage,
            plan.fast_route or "-",
            plan.reason,
            plan.plan_ms,
        )
        classification = plan.classification
        if classification is None:
            classification = resolve_turn_classification(
                session,
                normalized,
                turn_mode=turn_mode,
                twiml_greeting_already=twiml_greeting,
                source="handle_turn",
            )
        else:
            classification = resolve_turn_classification(
                session,
                normalized,
                turn_mode=turn_mode,
                twiml_greeting_already=twiml_greeting,
                plan_classification=classification,
                source="handle_turn_plan",
            )

        commit_fsm = build_execution_fsm_state(
            session,
            turn_mode=turn_mode,
            voice_stage=plan.stage or "idle",
            brain_gate_active=probe_brain_gate_active(
                session, normalized, turn_mode=turn_mode,
            ),
            active_workflow=active_workflow,
            workflow_llm_blocked=_llm_blocked_for_workflow(
                session, normalized, turn_mode, classification, active_workflow,
            ),
        )
        commit_intent(
            session,
            classification,
            commit_fsm,
            active_workflow=active_workflow,
            execution_policy=plan.execution_policy or "",
            turn_text=normalized,
            turn_mode=turn_mode,
        )
        classification = enforce_committed_intent_on_classification(
            session, classification, source="handle_turn_post_commit",
        )
        plan.classification = classification

        _log_intent_routing_decision(
            sid,
            classification,
            route=plan.fast_route or "",
            active_workflow=active_workflow,
        )

        from .conversation_state_graph import (
            derive_conversation_state_graph,
            log_conversation_state_graph,
        )
        from .conversation_state_graph_diff import (
            OBS_CONVERSATION_STATE_GRAPH_PENDING_ATTR,
            log_conversation_state_graph_diff,
        )
        from .conversation_replay_tape import record_turn_observability

        state_graph = derive_conversation_state_graph(
            session,
            turn_mode=turn_mode,
            caller_text=normalized,
            active_workflow=active_workflow,
            execution_policy=plan.execution_policy or "",
            voice_stage=plan.stage or "idle",
            workflow_llm_blocked=_llm_blocked_for_workflow(
                session, normalized, turn_mode, classification, active_workflow,
            ),
        )
        setattr(session, OBS_CONVERSATION_STATE_GRAPH_PENDING_ATTR, state_graph)
        log_conversation_state_graph(state_graph, source="handle_turn_post_commit")
        state_graph_diff = log_conversation_state_graph_diff(session)
        record_turn_observability(
            session,
            turn_index=int(getattr(session, "turn_count", 0) or 0),
            turn_id=str(getattr(session, "turn_count", 0) or 0),
            caller_text=normalized,
            turn_mode=turn_mode,
            classification=classification,
            execution_policy=plan.execution_policy or "",
            active_workflow=active_workflow,
            voice_stage=plan.stage or "idle",
            workflow_llm_blocked=_llm_blocked_for_workflow(
                session, normalized, turn_mode, classification, active_workflow,
            ),
            state_graph=state_graph,
            state_graph_diff=state_graph_diff,
        )

        from ..agent_runtime.not_found_escalation_flow import (
            try_product_search_fallback_escalation,
        )

        fallback_reply = try_product_search_fallback_escalation(session, normalized)
        if fallback_reply:
            spoken = await self._speak_support_handoff_reply(
                session, normalized, fallback_reply, send,
            )
            logger.info("product_search_purchase_insistence_handoff sid=%s", sid)
            return _result(spoken)

        if _should_product_clarify_turn(
            session,
            normalized,
            turn_mode,
            classification,
            plan,
            active_workflow,
        ):
            return await self._product_clarification_turn(
                session,
                normalized,
                send,
                turn_mode=turn_mode,
                classification=classification,
            )

        if _should_dispatch_product_search_workflow(
            session,
            normalized,
            turn_mode,
            classification,
            plan,
            active_workflow,
        ):
            product_once = await self._route_product_search_once(
                session,
                normalized,
                send,
                turn_mode=turn_mode,
                classification=classification,
                sid=sid,
            )
            if product_once is not None:
                return product_once

        from ..dialogue.anti_silence import anti_silence_reply
        from ..dialogue.side_speech import side_speech_reply

        side = side_speech_reply(normalized)
        if side:
            spoken = self._brain.finalize_response(session, side, [])
            spoken = await self._speak(session, normalized, spoken, send)
            logger.info("side_speech_short_circuit sid=%s", sid)
            return _result(spoken)

        presence = None
        if _anti_silence_allowed_for_turn(
            session,
            normalized,
            turn_mode,
            classification,
            plan,
            active_workflow,
        ):
            presence = anti_silence_reply(session, normalized)
        if presence:
            spoken = self._brain.finalize_response(session, presence, [])
            spoken = await self._speak(session, normalized, spoken, send)
            logger.info("anti_silence_short_circuit sid=%s", sid)
            return _result(spoken)

        from ..agent_runtime.payment_flow_state import checkout_payment_intent_detected

        if checkout_payment_intent_detected(normalized) and (
            getattr(session, "payment_cart_confirmed", False)
            or bool(getattr(session, "cart_items", None))
        ):
            checkout_sc = await self._handle_payment_checkout_short_circuit(
                session, normalized, send, turn_mode=turn_mode, sid=sid,
            )
            if checkout_sc is not None:
                return checkout_sc

        from ..agent_runtime.workflow_isolation import order_context_on_call
        from ..agent_runtime.order_flow_state import (
            is_order_followup_question,
            try_order_followup_reply,
        )

        if order_context_on_call(session) and is_order_followup_question(normalized):
            followup_early = try_order_followup_reply(session, normalized)
            if followup_early:
                spoken = self._brain.finalize_response(session, followup_early, [])
                spoken = await self._speak(session, normalized, spoken, send, interruptible=False)
                logger.info("order_followup_early sid=%s", sid)
                return _result(spoken)

        from ..agent_runtime.order_flow_state import (
            _should_skip_order_lookup,
            extract_order_number,
            is_actionable_order_number,
            try_another_order_short_circuit,
            try_order_collection_short_circuit,
            try_order_enrichment_short_circuit,
            try_order_followup_reply,
            try_order_hold_reply,
            try_order_repeat_reply,
        )

        if order_handling_allowed(session, turn_mode, normalized):
            awaiting_prompt = self._enforce_awaiting_order_ux(
                session, normalized, turn_mode=turn_mode,
            )
            if awaiting_prompt:
                spoken = await self._speak(session, normalized, awaiting_prompt, send)
                logger.info("guided_awaiting_order_number sid=%s", sid)
                return _result(spoken)

            if not payment_email_turn_priority(session, turn_mode):
                if not _should_skip_order_lookup(normalized, session, turn_mode=turn_mode):
                    spoken_order_num = extract_order_number(
                        normalized, session, turn_mode=turn_mode,
                    )
                    if spoken_order_num and is_actionable_order_number(spoken_order_num):
                        try:
                            order_hint = await try_order_enrichment_short_circuit(
                                session, normalized, turn_mode=turn_mode,
                            )
                        except Exception as exc:
                            logger.warning(
                                "order_enrichment_failed sid=%s err=%s",
                                sid,
                                type(exc).__name__,
                            )
                            order_hint = None
                        if order_hint and order_hint.force_reply:
                            from ..dialogue.call_closure import (
                                mark_awaiting_anything_else,
                                offer_anything_else_suffix,
                            )

                            spoken = self._brain.finalize_response(
                                session, order_hint.force_reply, [],
                            )
                            conv = self._voice_conversation(session)
                            if conv.get("stage") == "order_lookup":
                                self._mark_voice_conversation_completed(session)
                            else:
                                mark_awaiting_anything_else(session)
                                suffix = offer_anything_else_suffix()
                                if suffix.strip() not in spoken:
                                    spoken = f"{spoken.rstrip('.')}.{suffix}"
                            spoken = await self._speak(
                                session, normalized, spoken, send, interruptible=False,
                            )
                            logger.info("order_enrichment_short_circuit sid=%s", sid)
                            return _result(spoken)

            followup_reply = try_order_followup_reply(session, normalized)
            if followup_reply:
                spoken = self._brain.finalize_response(session, followup_reply, [])
                spoken = await self._speak(session, normalized, spoken, send, interruptible=False)
                logger.info("order_followup_short_circuit sid=%s", sid)
                return _result(spoken)

            repeat_reply = try_order_repeat_reply(session, normalized)
            spoken_num = extract_order_number(normalized, session, turn_mode=turn_mode)
            if repeat_reply and not (spoken_num and is_actionable_order_number(spoken_num)):
                spoken = self._brain.finalize_response(session, repeat_reply, [])
                spoken = await self._speak(session, normalized, spoken, send, interruptible=False)
                logger.info("order_repeat_short_circuit sid=%s", sid)
                return _result(spoken)

            hold_reply = try_order_hold_reply(session, normalized)
            if hold_reply:
                spoken = self._brain.finalize_response(session, hold_reply, [])
                spoken = await self._speak(session, normalized, spoken, send, interruptible=False)
                logger.info("order_hold_short_circuit sid=%s", sid)
                return _result(spoken)

            another_hint = try_another_order_short_circuit(
                session, normalized, turn_mode=turn_mode,
            )
            if another_hint and another_hint.force_reply:
                spoken = self._brain.finalize_response(
                    session, another_hint.force_reply, [],
                )
                spoken = await self._speak(session, normalized, spoken, send)
                logger.info("another_order_short_circuit sid=%s", sid)
                return _result(spoken)

            collection_hint = try_order_collection_short_circuit(
                session, normalized, turn_mode=turn_mode,
            )
            if collection_hint and collection_hint.force_reply:
                conv = self._voice_conversation(session)
                reply = (
                    _GUIDED_AWAITING_ORDER_PROMPT
                    if conv.get("stage") == "awaiting_order_number"
                    else collection_hint.force_reply
                )
                spoken = self._brain.finalize_response(session, reply, [])
                spoken = await self._speak(session, normalized, spoken, send)
                logger.info("order_collection_short_circuit sid=%s", sid)
                return _result(spoken)

        email_result = None
        if payment_handling_allowed(session, turn_mode, normalized):
            email_result = await self._handle_email_fsm(
                session, normalized, send, turn_mode=turn_mode,
            )
        if email_result is not None:
            return email_result

        if support_handling_allowed(session, turn_mode, normalized):
            handoff = await self._route_support_handoff_workflow(
                session, normalized, send, turn_mode=turn_mode, sid=sid,
            )
            if handoff is not None:
                return handoff

        if classification.action == "instant" and classification.instant_reply:
            if classification.reason == "isbn_offer_prompt":
                from ..agent_runtime.isbn_short_circuit import arm_isbn_digit_collection

                arm_isbn_digit_collection(session)
            instant_reply = classification.instant_reply
            if classification.reason == "order_collection_prompt":
                self._voice_conversation(session)["stage"] = "awaiting_order_number"
                self._voice_conversation(session)["last_intent"] = "order_lookup"
                instant_reply = _GUIDED_AWAITING_ORDER_PROMPT
            spoken = self._brain.finalize_response(session, instant_reply, [])
            spoken = await self._speak(session, normalized, spoken, send)
            logger.info(
                "fast_classifier_instant sid=%s reason=%s ms=%.0f",
                sid,
                classification.reason,
                (time.monotonic() - t0) * 1000,
            )
            return _result(spoken)

        if classification.is_cancellation_request and not support_handling_allowed(
            session, turn_mode, normalized,
        ):
            from ..agent_runtime.not_found_escalation_flow import (
                try_cancellation_support_handoff,
            )

            cancel_hint = await try_cancellation_support_handoff(
                session, normalized, turn_mode=turn_mode,
            )
            if cancel_hint.force_reply:
                spoken = self._brain.finalize_response(session, cancel_hint.force_reply, [])
                spoken = await self._speak(session, normalized, spoken, send)
                logger.info("cancellation_support_handoff sid=%s", sid)
                return _result(spoken)

        from ..agent_runtime.order_flow_state import (
            _should_skip_order_lookup,
            extract_order_number,
            order_intent_detected,
            try_order_enrichment_short_circuit,
        )

        is_order_turn = (
            order_handling_allowed(session, turn_mode, normalized)
            and not _should_skip_order_lookup(normalized, session, turn_mode=turn_mode)
            and (turn_mode or "").lower() not in ("isbn", "email")
            and (
                (turn_mode or "").lower() == "order"
                or bool(extract_order_number(normalized, session, turn_mode=turn_mode))
                or classification.is_order_lookup
                or order_intent_detected(normalized)
            )
        )
        if is_order_turn:
            try:
                order_hint = await try_order_enrichment_short_circuit(
                    session, normalized, turn_mode=turn_mode,
                )
            except Exception as exc:
                logger.warning("order_enrichment_failed sid=%s err=%s", sid, type(exc).__name__)
                order_hint = None
            if order_hint and order_hint.force_reply:
                self._mark_voice_conversation_completed(session)
                spoken = self._brain.finalize_response(session, order_hint.force_reply, [])
                spoken = await self._speak(session, normalized, spoken, send, interruptible=False)
                logger.info("order_enrichment_short_circuit sid=%s", sid)
                return _result(spoken)

            if order_intent_detected(normalized) and not extract_order_number(
                normalized, session, turn_mode=turn_mode,
            ):
                from ..agent_runtime.order_flow_state import try_order_collection_short_circuit

                collection_hint = try_order_collection_short_circuit(
                    session, normalized, turn_mode=turn_mode,
                )
                if collection_hint and collection_hint.force_reply:
                    conv = self._voice_conversation(session)
                    reply = (
                        _GUIDED_AWAITING_ORDER_PROMPT
                        if conv.get("stage") == "awaiting_order_number"
                        else collection_hint.force_reply
                    )
                    spoken = self._brain.finalize_response(
                        session, reply, [],
                    )
                    spoken = await self._speak(session, normalized, spoken, send)
                    logger.info("order_collection_before_brain sid=%s", sid)
                    return _result(spoken)

        from ..agent_runtime.commerce_flow_state import try_cart_inquiry_reply

        if commerce_handling_allowed(session, turn_mode, normalized):
            commerce_hold = try_commerce_hold_reply(session, normalized)
            if commerce_hold:
                spoken = await self._speak(session, normalized, commerce_hold, send)
                logger.info("commerce_hold_short_circuit sid=%s", sid)
                return _result(spoken)

            commerce_repeat = try_commerce_repeat_reply(session, normalized)
            if commerce_repeat:
                spoken = await self._speak(session, normalized, commerce_repeat, send)
                logger.info("commerce_repeat_short_circuit sid=%s", sid)
                return _result(spoken)

            cart_sc = await self._handle_product_cart_short_circuit(
                session, normalized, send, turn_mode=turn_mode, sid=sid,
            )
            if cart_sc is not None:
                return cart_sc

            cart_reply = try_cart_inquiry_reply(
                session, normalized, turn_mode=turn_mode,
            )
            if cart_reply:
                record_commerce_voice_reply(session, cart_reply)
                self._sync_session_cart_memory(session)
                spoken = self._brain.finalize_response(session, cart_reply, [])
                spoken = await self._speak_cart(session, normalized, spoken, send, sid=sid)
                logger.info("cart_inquiry_short_circuit sid=%s", sid)
                return _result(spoken)

            commerce_hint = process_commerce_turn(
                session, normalized, turn_mode=turn_mode,
            )
            if commerce_hint.force_reply:
                record_commerce_voice_reply(session, commerce_hint.force_reply)
                if commerce_hint.book_added:
                    self._sync_session_cart_memory(session)
                spoken = enforce_commerce_response(
                    session,
                    self._brain.finalize_response(session, commerce_hint.force_reply, []),
                    [],
                )
                spoken = await self._speak_cart(session, normalized, spoken, send, sid=sid)
                logger.info(
                    "commerce_flow_short_circuit sid=%s book_added=%s version=%s",
                    sid,
                    commerce_hint.book_added,
                    COMMERCE_FLOW_VERSION,
                )
                return _result(spoken)

        from ..agent_runtime.yes_engagement import is_bare_yes, yes_engagement_reply
        from ..agent_runtime.workflow_isolation import order_context_on_call

        if is_bare_yes(normalized) and (
            commerce_handling_allowed(session, turn_mode, normalized)
            or order_context_on_call(session)
        ):
            engage = yes_engagement_reply(session) or ""
            spoken = self._brain.finalize_response(session, engage, [])
            spoken = await self._speak(session, normalized, spoken, send)
            logger.info("yes_engagement_short_circuit sid=%s", sid)
            return _result(spoken)

        if classification.action == "ack_then_brain" and classification.ack_reply:
            await schedule_voice_output(
                session,
                classification.ack_reply,
                priority=1,
                send=send,
                interruptible=True,
                send_last=False,
            )

        turn_policy, turn_fsm = self._resolve_turn_execution_policy(
            session,
            normalized,
            turn_mode,
            classification,
            plan,
            active_workflow,
        )
        logger.info(
            "execution_policy_resolved sid=%s policy=%s brain_gate=%s pcs=%s",
            sid,
            turn_policy,
            turn_fsm.brain_gate_active,
            turn_fsm.product_commerce_status,
        )

        if not policy_allows_llm(turn_policy):  # type: ignore[arg-type]
            brain_gate_result = await self._speak_brain_gate_reply(
                session, normalized, send, turn_mode=turn_mode, sid=sid,
            )
            if brain_gate_result is not None:
                return brain_gate_result

            return await self._route_non_llm_execution_policy(
                session,
                normalized,
                send,
                turn_mode=turn_mode,
                classification=classification,
                plan=plan,
                active_workflow=active_workflow,
                execution_policy=turn_policy,
                fsm=turn_fsm,
                sid=sid,
            )

        if requires_product_clarification_before_brain(
            session, normalized, turn_mode,
        ) and locked_workflow_requires_product_search(classification):
            logger.info("product_clarification_pre_brain sid=%s", sid)
            return await self._product_clarification_turn(
                session,
                normalized,
                send,
                turn_mode=turn_mode,
                classification=classification,
            )

        if locked_workflow_requires_product_search(classification):
            if not getattr(session, "_product_search_routed_this_turn", False):
                product_locked = await self._route_product_search_once(
                    session,
                    normalized,
                    send,
                    turn_mode=turn_mode,
                    classification=classification,
                    sid=sid,
                )
                if product_locked is not None:
                    return product_locked
            return await self._product_clarification_turn(
                session,
                normalized,
                send,
                turn_mode=turn_mode,
                classification=classification,
            )

        if not locked_workflow_allows_llm(classification):
            spoken = _STUCK_RECOVERY
            spoken = await self._speak(session, normalized, spoken, send)
            logger.info("intent_lock_blocked_brain sid=%s workflow=%s", sid, classification.locked_workflow)
            return _result(spoken)

        classification = enforce_committed_intent_on_classification(
            session, classification, source="llm_pipeline",
        )

        live_context = self._build_live_context(
            session, normalized, turn_mode=turn_mode, caller_context=caller_context,
        )

        stream_enabled = bool(getattr(self._settings, "VOICE_LLM_STREAM_ENABLED", True))
        llm_may_stream = llm_streaming_permitted(turn_policy) and stream_enabled

        async def _run_brain(on_token=None):
            return await self._brain.run_turn(
                session,
                normalized,
                send,
                turn_mode=turn_mode,
                use_strong_model=classification.use_strong_model,
                live_context=live_context,
                caller_context=caller_context,
                on_token=on_token,
            )

        try:
            if llm_may_stream:
                final_text, tools_used, tool_results, streamed_parts = (
                    await self._speak_streaming_llm(
                        session,
                        normalized,
                        send,
                        on_token_source=_run_brain,
                        execution_policy=turn_policy,
                    )
                )
            else:
                final_text, tools_used, tool_results = await buffer_llm_response_until_complete(
                    _run_brain,
                )
                streamed_parts = []
                logger.info(
                    "llm_response_buffered sid=%s policy=%s stream_setting=%s",
                    sid,
                    turn_policy,
                    str(stream_enabled).lower(),
                )
        except Exception as exc:
            logger.error("brain_error sid=%s err=%s", sid, type(exc).__name__)
            spoken = _OPENAI_FALLBACK
            spoken = await self._speak(session, normalized, spoken, send)
            return _result(spoken)

        if not final_text:
            spoken = _STUCK_RECOVERY
            spoken = await self._speak(session, normalized, spoken, send)
            return _result(spoken)

        final_text = self._enforce_llm_voice_contract(final_text)
        classification = enforce_committed_intent_on_classification(
            session, classification, source="llm_post_buffer",
        )
        final_text = enforce_commerce_response(session, final_text, tool_results)
        from ..agent_runtime.order_parallel_enrichment import enforce_order_response

        final_text = enforce_order_response(session, final_text, tool_results)
        if any(name == "add_to_cart" and r.get("success") for name, r in tool_results):
            self._sync_session_cart_memory(session)
        spoken = self._brain.finalize_response(session, final_text, tool_results)

        if streamed_parts:
            session.history.append({"role": "assistant", "content": spoken})
            self._record_turn(session, normalized, spoken)
        else:
            await wait_for_speech_completion_before_next_action(session)
            spoken = await self._speak(
                session, normalized, spoken, send, skip_user_history=True,
            )

        logger.info(
            "voice_commerce_complete sid=%s tools=%s chars=%d ms=%.0f reason=%s",
            sid,
            ",".join(tools_used) or "none",
            len(spoken),
            (time.monotonic() - t0) * 1000,
            classification.reason,
        )
        from ..dialogue.call_closure import caller_wants_to_end, process_call_closure_turn

        if caller_wants_to_end(normalized):
            closure = process_call_closure_turn(session, normalized)
            if closure and closure.end_call:
                return _result(closure.reply, end_call=True)
        return _result(spoken)

    @staticmethod
    def _record_turn(session: "SessionState", user_text: str, assistant_text: str) -> None:
        try:
            from ..conversation.call_memory import record_turn_pair

            record_turn_pair(session, user_text, assistant_text)
        except Exception:  # noqa: BLE001
            pass


def get_voice_commerce_runtime(settings=None) -> VoiceCommerceRuntime:
    global _runtime
    if _runtime is None or settings is not None:
        _runtime = VoiceCommerceRuntime(settings)
    return _runtime


def voice_commerce_enabled(settings=None) -> bool:
    from ..config import get_settings

    s = settings or get_settings()
    return bool(getattr(s, "VOICE_COMMERCE_RUNTIME_ENABLED", True))
