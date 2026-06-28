"""
TurnAssembler — debounce and merge STT fragments before engine.handle_turn() (v4.9).

ConversationRelay sends short final transcript chunks. This module waits,
merges, and emits one assembled turn when complete.
"""
from __future__ import annotations

import asyncio
import logging
import re
import uuid
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Optional

from .turn_taking import is_complete_isbn, is_complete_order_number, is_isbn_permission_question, should_collect_isbn

logger = logging.getLogger(__name__)

_WAIT_EXTEND = re.compile(
    r"\b(wait|hold on|one (?:second|moment)|i repeat|let me repeat)\b",
    re.IGNORECASE,
)
_RESET_BUFFER = re.compile(
    r"\b(check again|repeat again|start over|let me start|sorry repeat)\b",
    re.IGNORECASE,
)
_KEEPALIVE_FRAGMENT = re.compile(
    r"\b(?:hello\??|are you there|"
    r"why are you (?:not (?:responding|talking|proceeding|telling(?: anything)?)|silent|quiet)|"
    r"why aren't you (?:asking|responding|talking|proceeding)|"
    r"you are (?:silent|quiet|not talking)|"
    r"not (?:responding|talking|proceeding))\b",
    re.IGNORECASE,
)
_BARE_AFFIRM = re.compile(
    r"^\s*(yes|yeah|yep|yup|sure|ok|okay|correct|right|go ahead)\s*[.!]*\s*$",
    re.IGNORECASE,
)
_ISBN_CONTINUATION = re.compile(
    r"\b(isbn|digit|number|here it is|i will give you|wait)\b",
    re.IGNORECASE,
)
_PARTIAL_ISBN_CLARIFY = (
    "I have part of it. Please continue with the remaining digits."
)
_KEEPALIVE_RESPONSE = "No problem, I'm here. Go ahead when you're ready."
_EMAIL_COMPLETE = re.compile(
    r"[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}",
    re.IGNORECASE,
)
_EMAIL_SPOKEN = re.compile(
    r"\b[a-z0-9._%+\-]+\s+(?:at|@)\s*[a-z0-9.\-]+(?:\s+(?:dot|\.)\s+(?:com|net|org))?\b",
    re.IGNORECASE,
)
_ORDER_HINT = re.compile(r"\b(order|order number|order #)\b", re.I)
_DIGIT_FRAGMENT = re.compile(r"^[\d\s\.\-]+$")


@dataclass
class AssemblerState:
    buffer: str = ""
    mode: str = "normal"  # normal | isbn | email | order
    fragment_group_id: str = ""
    last_emit_id: str = ""
    emitted_ids: set[str] = field(default_factory=set)
    extend_until: float = 0.0
    isbn_partial_since: float = 0.0
    hold_started_at: float = 0.0
    pending_clarify: str = ""


@dataclass
class AssembledTurn:
    """One debounced caller utterance passed to the LLM runtime."""

    text: str
    mode: str = "normal"


class TurnAssembler:
    """
    Per-session turn assembler with debounce and fragment merging.

    ingest() returns True when the fragment is held (engine not called yet).
    """

    def __init__(self, settings=None):
        from ..config import get_settings
        self._settings = settings or get_settings()
        self._state = AssemblerState()
        self._debounce_task: Optional[asyncio.Task] = None
        self._emit_callback: Optional[Callable[[str], Awaitable[None]]] = None
        self._lock = asyncio.Lock()
        self._call_sid = ""

    def _new_group_id(self) -> str:
        return str(uuid.uuid4())[:12]

    def _detect_mode(self, text: str, *, call_sid: str = "", pending_isbn_buffer: str = "") -> str:
        t = text.lower().strip()
        if _EMAIL_COMPLETE.search(text) or _EMAIL_SPOKEN.search(t) or " at " in t or "@" in t:
            return "email"
        book_collection = False
        if call_sid:
            from ..agent_runtime.conversation_state_machine import get_conversation_state
            cs = get_conversation_state(call_sid)
            book_collection = cs.mode in ("book_collection", "isbn_collection")
        if pending_isbn_buffer or self._state.mode == "isbn":
            if _DIGIT_FRAGMENT.match(text.strip()) or should_collect_isbn(text, book_collection=True):
                return "isbn"
        if should_collect_isbn(text, book_collection=book_collection) or is_complete_isbn(text):
            return "isbn"
        from ..agent_runtime.order_flow_state import normalize_order_number_from_speech

        digits = "".join(c for c in text if c.isdigit())
        if _ORDER_HINT.search(t) or self._state.mode == "order":
            if normalize_order_number_from_speech(text) or _DIGIT_FRAGMENT.match(text.strip()):
                return "order"
        if (
            _DIGIT_FRAGMENT.match(text.strip())
            and 4 <= len(digits) <= 10
            and not digits.startswith(("978", "979"))
        ):
            return "order"
        if self._state.mode == "isbn" and should_collect_isbn(text, book_collection=book_collection):
            return "isbn"
        if not should_collect_isbn(text, book_collection=book_collection):
            return "normal"
        digits = "".join(c for c in text if c.isdigit())
        if len(digits) == 0:
            return "normal"
        if len(digits) >= 10:
            return "isbn"
        if _ISBN_DIGIT_HINT(text):
            return "isbn"
        return "normal"

    def _merge_text(self, existing: str, new: str) -> str:
        if not existing:
            return new.strip()
        if not new.strip():
            return existing
        # Avoid duplicate overlap
        if new.strip().lower() in existing.lower():
            return existing
        if existing.strip().lower() in new.strip().lower():
            return new.strip()
        return f"{existing} {new}".strip()

    def _is_complete(self, text: str, mode: str) -> tuple[bool, str]:
        if mode == "isbn":
            if is_complete_isbn(text):
                return True, "complete_isbn"
            digits = "".join(c for c in text if c.isdigit())
            if len(digits) in (10, 13):
                return True, "complete_isbn"
        if mode == "email":
            if _EMAIL_COMPLETE.search(text):
                return True, "complete_email"
            if _EMAIL_SPOKEN.search(text) and " dot " in text.lower():
                return True, "complete_email_spoken"
        if mode == "order":
            if is_complete_order_number(text):
                return True, "complete_order"
        if mode == "normal":
            return True, "normal_speech"
        return False, "incomplete"

    def _debounce_ms(self, mode: str) -> float:
        s = self._settings
        if mode == "isbn":
            return s.VOICE_DIGIT_COLLECTION_SILENCE_MS
        if mode == "email":
            return s.VOICE_EMAIL_COLLECTION_SILENCE_MS
        if mode == "order":
            return s.VOICE_ORDER_COLLECTION_SILENCE_MS
        return s.VOICE_TURN_ASSEMBLER_DEBOUNCE_MS

    def _should_emit_isbn_immediately(self, text: str) -> bool:
        """Emit as soon as a checksum-valid complete ISBN is present."""
        return is_complete_isbn(text)

    def _can_emit_immediately(self, text: str, mode: str) -> tuple[bool, str]:
        if mode == "email":
            if _EMAIL_COMPLETE.search(text):
                return True, "complete_email"
            if _EMAIL_SPOKEN.search(text) and " dot " in text.lower():
                return True, "complete_email_spoken"
        if mode == "isbn" and self._should_emit_isbn_immediately(text):
            return True, "complete_isbn"
        if mode == "order" and is_complete_order_number(text):
            return True, "complete_order"
        if mode == "normal":
            from ..orchestrator.intent_router import is_smalltalk, is_vague_product_request

            stripped = text.strip()
            if is_isbn_permission_question(stripped):
                return True, "isbn_permission_question"
            if _BARE_AFFIRM.match(stripped):
                return True, "complete_affirmative"
            if is_smalltalk(stripped):
                return True, "immediate_greeting"
            if is_vague_product_request(stripped):
                return True, "immediate_vague_product"
        return False, "incomplete"

    async def _emit_buffered(
        self,
        sid: str,
        on_emit: Callable[[AssembledTurn], Awaitable[None]],
        reason: str,
    ) -> bool:
        st = self._state
        if not st.buffer:
            return True
        assembled = st.buffer
        emit_id = str(hash(assembled))
        if emit_id in st.emitted_ids:
            st.buffer = ""
            st.mode = "normal"
            st.fragment_group_id = ""
            return True
        st.emitted_ids.add(emit_id)
        emit_mode = st.mode
        st.buffer = ""
        st.mode = "normal"
        st.fragment_group_id = ""
        st.last_emit_id = emit_id
        logger.info(
            "turn_assembler_emit sid=%s mode=%s reason=%s",
            sid, emit_mode, reason,
        )
        await on_emit(AssembledTurn(text=assembled, mode=emit_mode))
        return False

    async def ingest(
        self,
        fragment: str,
        on_emit: Callable[[AssembledTurn], Awaitable[None]],
        *,
        call_sid: str = "",
        pending_isbn_buffer: str = "",
    ) -> bool:
        """
        Accept a transcript fragment.

        Returns True if held (not yet emitted to engine).
        Returns False if emitted immediately.
        """
        async with self._lock:
            sid = (call_sid or "")[:6]
            if call_sid:
                self._call_sid = call_sid
            self._pending_isbn_buffer = pending_isbn_buffer or ""
            frag = (fragment or "").strip()
            if not frag:
                return True

            st = self._state

            # Permission to give ISBN/title — never hold; emit immediately for fast reply.
            if is_isbn_permission_question(frag):
                st.buffer = frag
                st.mode = "normal"
                st.isbn_partial_since = 0.0
                return await self._emit_buffered(sid, on_emit, "isbn_permission_question")


            if _RESET_BUFFER.search(frag):
                st.buffer = ""
                st.mode = "normal"
                st.isbn_partial_since = 0.0
                st.pending_clarify = ""
                st.fragment_group_id = self._new_group_id()
                logger.info(
                    "turn_assembler_hold sid=%s mode=%s reason=buffer_reset",
                    sid, st.mode,
                )
                return True

            # ISBN escape: keepalive/frustration should not merge into ISBN buffer
            if st.mode == "isbn" and _KEEPALIVE_FRAGMENT.search(frag):
                digits = "".join(c for c in st.buffer if c.isdigit())
                st.pending_clarify = (
                    f"Yes, I'm here. {_PARTIAL_ISBN_CLARIFY}"
                    if len(digits) in (10, 11, 12)
                    else "Yes, I'm here."
                )
                st.buffer = frag
                st.mode = "normal"
                st.isbn_partial_since = 0.0
                logger.info(
                    "turn_assembler_emit sid=%s mode=normal reason=isbn_escape_keepalive",
                    sid,
                )
                return await self._emit_buffered(sid, on_emit, "isbn_escape_keepalive")

            if st.mode == "isbn" and not _ISBN_CONTINUATION.search(frag):
                frag_digits = "".join(c for c in frag if c.isdigit())
                if not frag_digits:
                    st.pending_clarify = ""
                    st.buffer = frag
                    st.mode = "normal"
                    logger.info(
                        "turn_assembler_emit sid=%s mode=normal reason=isbn_non_digit_escape",
                        sid,
                    )
                    return await self._emit_buffered(sid, on_emit, "isbn_non_digit_escape")

            if _WAIT_EXTEND.search(frag):
                import time
                st.extend_until = asyncio.get_event_loop().time() + 3.0
                max_hold_s = getattr(self._settings, "VOICE_COLLECTION_MAX_HOLD_MS", 7000) / 1000
                if st.hold_started_at <= 0:
                    st.hold_started_at = time.monotonic()
                elif time.monotonic() - st.hold_started_at >= max_hold_s:
                    keepalive = getattr(self._settings, "VOICE_COLLECTION_KEEPALIVE_ENABLED", True)
                    if keepalive:
                        st.buffer = _KEEPALIVE_RESPONSE
                        st.mode = "normal"
                        st.hold_started_at = 0.0
                        return await self._emit_buffered(sid, on_emit, "wait_hold_timeout")
                st.buffer = self._merge_text(st.buffer, frag)
                merged_mode = self._detect_mode(
                    st.buffer,
                    call_sid=call_sid,
                    pending_isbn_buffer=self._pending_isbn_buffer,
                )
                if merged_mode != "normal":
                    st.mode = merged_mode
                elif is_complete_isbn(st.buffer):
                    st.mode = "isbn"
                if self._debounce_task and not self._debounce_task.done():
                    self._debounce_task.cancel()
                logger.info(
                    "turn_assembler_hold sid=%s mode=%s reason=wait_extend len=%d",
                    sid, st.mode, len(st.buffer),
                )
                return True

            detected = self._detect_mode(
                frag,
                call_sid=call_sid,
                pending_isbn_buffer=self._pending_isbn_buffer,
            )
            if st.buffer and st.mode != "normal":
                mode = st.mode
            else:
                mode = detected if detected != "normal" else (st.mode if st.buffer else "normal")

            if not st.fragment_group_id:
                st.fragment_group_id = self._new_group_id()

            if st.buffer:
                st.buffer = self._merge_text(st.buffer, frag)
                redetected = self._detect_mode(
                    st.buffer,
                    call_sid=call_sid,
                    pending_isbn_buffer=self._pending_isbn_buffer,
                )
                if redetected != "normal":
                    st.mode = redetected
                elif mode != "normal":
                    st.mode = mode
                elif is_complete_isbn(st.buffer):
                    st.mode = "isbn"
                logger.info(
                    "turn_assembler_merge sid=%s mode=%s len=%d",
                    sid, st.mode, len(st.buffer),
                )
            else:
                st.buffer = frag
                st.mode = mode

            immediate, reason = self._can_emit_immediately(st.buffer, st.mode)
            if immediate:
                return await self._emit_buffered(sid, on_emit, reason)

            logger.info(
                "turn_assembler_buffer sid=%s mode=%s len=%d reason=%s",
                sid, st.mode, len(st.buffer), reason,
            )
            self._emit_callback = on_emit
            if self._debounce_task and not self._debounce_task.done():
                self._debounce_task.cancel()
            self._debounce_task = asyncio.create_task(
                self._debounced_emit(sid, st.mode),
                name=f"turn-assembler-{sid}",
            )
            return True

    async def _debounced_emit(self, sid: str, mode: str) -> None:
        delay_ms = self._debounce_ms(mode)
        try:
            await asyncio.sleep(delay_ms / 1000)
        except asyncio.CancelledError:
            return

        async with self._lock:
            st = self._state
            if not st.buffer:
                return

            if _BARE_AFFIRM.match(st.buffer.strip()):
                await self._emit_buffered(sid, self._emit_callback, "debounce_affirmative")
                return

            if is_complete_isbn(st.buffer):
                st.mode = "isbn"
            elif st.mode == "normal":
                redetected = self._detect_mode(
                    st.buffer,
                    call_sid=self._call_sid,
                    pending_isbn_buffer=getattr(self, "_pending_isbn_buffer", ""),
                )
                if redetected != "normal":
                    st.mode = redetected

            emit_mode = st.mode
            digits = "".join(c for c in st.buffer if c.isdigit())
            if emit_mode == "isbn" and len(digits) > 13:
                from ..tools.isbn_validator import _sliding_window_isbn13

                found = _sliding_window_isbn13(digits)
                if found:
                    st.mode = "isbn"
                    logger.info(
                        "turn_assembler_emit sid=%s mode=isbn reason=sliding_window_isbn len=%d",
                        sid,
                        len(digits),
                    )
                    await self._emit_buffered(sid, self._emit_callback, "sliding_window_isbn")
                    return
            if emit_mode == "isbn" and not is_complete_isbn(st.buffer):
                import time
                if len(digits) == 0:
                    st.mode = "normal"
                    await self._emit_buffered(sid, self._emit_callback, "isbn_zero_digits_escape")
                    return
                if st.isbn_partial_since <= 0:
                    st.isbn_partial_since = time.monotonic()
                timeout_s = getattr(self._settings, "VOICE_ISBN_PARTIAL_TIMEOUT_MS", 5000) / 1000
                if (
                    1 <= len(digits) <= 12
                    and time.monotonic() - st.isbn_partial_since >= timeout_s
                ):
                    st.isbn_partial_since = 0.0
                    logger.info(
                        "turn_assembler_emit sid=%s mode=isbn reason=partial_isbn_timeout digits=%d",
                        sid, len(digits),
                    )
                    await self._emit_buffered(sid, self._emit_callback, "partial_isbn_timeout")
                    return
                logger.info(
                    "turn_assembler_hold sid=%s mode=%s reason=incomplete_isbn digits=%d",
                    sid, emit_mode, len(digits),
                )
                return

            buf_lower = st.buffer.lower()
            if emit_mode == "email" or (" at " in buf_lower and "dot" in buf_lower):
                if " at " not in buf_lower:
                    return

            if self._emit_callback:
                await self._emit_buffered(sid, self._emit_callback, f"debounce_{emit_mode}")

    async def flush(self, on_emit: Callable[[AssembledTurn], Awaitable[None]], *, call_sid: str = "") -> None:
        """Force-emit any buffered text (e.g. on disconnect)."""
        async with self._lock:
            if self._debounce_task and not self._debounce_task.done():
                self._debounce_task.cancel()
            if self._state.buffer:
                assembled = self._state.buffer
                emit_mode = self._state.mode
                self._state.buffer = ""
                self._state.mode = "normal"
                await on_emit(AssembledTurn(text=assembled, mode=emit_mode))


def _ISBN_DIGIT_HINT(text: str) -> bool:
    if not should_collect_isbn(text):
        return False
    digits = "".join(c for c in text if c.isdigit())
    words = text.strip().split()
    digit_words = sum(
        1 for w in words
        if w.isdigit() or w in {
            "zero", "one", "two", "three", "four", "five",
            "six", "seven", "eight", "nine",
        }
    )
    return len(digits) >= 10 or digit_words >= 10


_assemblers: dict[str, TurnAssembler] = {}


def get_turn_assembler(call_sid: str, settings=None) -> TurnAssembler:
    if call_sid not in _assemblers:
        _assemblers[call_sid] = TurnAssembler(settings=settings)
    return _assemblers[call_sid]


def clear_turn_assembler(call_sid: str) -> None:
    _assemblers.pop(call_sid, None)
