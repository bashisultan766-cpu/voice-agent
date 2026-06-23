"""
ConversationRelay outbound text delivery (v4.11.1).

Ensures Twilio receives valid text-token messages with last=true on playable content.
"""
from __future__ import annotations

import logging
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Optional

from ..safety.response_sanitizer import sanitize_customer_response

logger = logging.getLogger(__name__)

SendFn = Callable[[dict], Awaitable[None]]

_LEAK_CHECK = re.compile(
    r"(available tools|system prompt|you are eric|processing fee|role=tool)",
    re.IGNORECASE,
)

_DEFAULT_CHUNK = 500


@dataclass
class SendResult:
    sent: bool = False
    skipped: bool = False
    failed: bool = False
    chars: int = 0
    chunks: int = 0
    reason: str = ""


@dataclass
class ConversationRelayStats:
    prompts_received: int = 0
    assembled_turns: int = 0
    responses_sent: int = 0
    last_outbound_type: str = ""


def mask_outbound_log_text(text: str, max_chars: int = 160) -> str:
    """Mask PII for outbound send logs."""
    from ..safety.response_sanitizer import _mask_safe_log_text
    masked = _mask_safe_log_text(text)
    if len(masked) > max_chars:
        return masked[: max_chars - 3] + "..."
    return masked


def _sanitize_outbound_text(text: str, *, call_sid: str = "") -> str:
    if not text or not text.strip():
        return ""
    if _LEAK_CHECK.search(text):
        result = sanitize_customer_response(text, call_sid=call_sid)
        return result.text.strip()
    return text.strip()


def build_text_payload(
    token: str,
    *,
    last: bool,
    interruptible: bool = True,
    preemptible: bool = False,
    lang: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "type": "text",
        "token": token,
        "last": last,
        "interruptible": interruptible,
        "preemptible": preemptible,
    }
    if lang:
        payload["lang"] = lang
    return payload


async def send_text_to_conversation_relay(
    send_fn: SendFn,
    text: str,
    *,
    sid: str = "",
    turn: int | None = None,
    interruptible: bool = True,
    preemptible: bool = False,
    lang: str | None = None,
    call_sid: str = "",
    chunk_size: int = _DEFAULT_CHUNK,
) -> SendResult:
    """
    Send customer-facing text to Twilio ConversationRelay via send_fn.

    Short responses: one message with last=true.
    Long text: split into chunks; final chunk has last=true.
    """
    sid_short = (sid or call_sid or "")[:6]
    turn_n = turn if turn is not None else 0

    cleaned = _sanitize_outbound_text(text, call_sid=call_sid or sid)
    if not cleaned:
        logger.debug(
            "conversationrelay_text_skipped sid=%s turn=%s reason=empty",
            sid_short, turn_n,
        )
        return SendResult(skipped=True, reason="empty")

    if len(cleaned) <= chunk_size:
        chunks = [cleaned]
    else:
        chunks = [
            cleaned[i : i + chunk_size]
            for i in range(0, len(cleaned), chunk_size)
        ]

    sent_count = 0
    total_chars = 0
    try:
        for i, chunk in enumerate(chunks):
            is_last = i == len(chunks) - 1
            payload = build_text_payload(
                chunk,
                last=is_last,
                interruptible=interruptible,
                preemptible=preemptible,
                lang=lang,
            )
            logger.info(
                "conversationrelay_text_send_attempt sid=%s turn=%s chars=%d last=%s",
                sid_short, turn_n, len(chunk), is_last,
            )
            await send_fn(payload)
            sent_count += 1
            total_chars += len(chunk)
            logger.info(
                "conversationrelay_text_sent sid=%s turn=%s chars=%d",
                sid_short, turn_n, len(chunk),
            )
        return SendResult(sent=True, chars=total_chars, chunks=sent_count)
    except Exception as exc:
        logger.error(
            "conversationrelay_text_send_failed sid=%s error_type=%s",
            sid_short, type(exc).__name__,
        )
        return SendResult(failed=True, reason=type(exc).__name__)


class ConversationRelayOutbound:
    """
    Adapts engine send() callbacks to ConversationRelay text delivery.

    Fixes v4.11 bug: engine sends content with last=false then empty last=true.
    ElevenLabs TTS requires last=true on the playable token.
    """

    def __init__(
        self,
        send_fn: SendFn,
        settings,
        call_sid: str,
        stats: ConversationRelayStats,
    ):
        self._send_fn = send_fn
        self._settings = settings
        self._call_sid = call_sid
        self._stats = stats
        self._buffer = ""
        self._streamed_any = False
        self._turn = 0

    @property
    def stats(self) -> ConversationRelayStats:
        return self._stats

    def set_turn(self, turn: int) -> None:
        self._turn = turn

    async def engine_send(self, msg: dict) -> None:
        """Receive engine/runtime send dict and deliver to Twilio."""
        if msg.get("type") != "text":
            return

        token = msg.get("token") or ""
        is_last = bool(msg.get("last", False))
        interruptible = msg.get(
            "interruptible",
            getattr(self._settings, "VOICE_CR_TEXT_INTERRUPTIBLE", True),
        )
        preemptible = msg.get(
            "preemptible",
            getattr(self._settings, "VOICE_CR_TEXT_PREEMPTIBLE", False),
        )
        lang = getattr(self._settings, "VOICE_LANGUAGE", None) or None

        sid = self._call_sid[:6]

        if token:
            if is_last:
                combined = self._buffer + token
                self._buffer = ""
                await self._deliver(combined, interruptible, preemptible, lang)
            else:
                self._buffer += token
                self._streamed_any = True
        elif is_last and self._buffer:
            await self._deliver(self._buffer, interruptible, preemptible, lang)
            self._buffer = ""
        elif is_last and not self._buffer and not self._streamed_any:
            logger.info(
                "conversationrelay_no_response sid=%s reason=empty_turn_done turn=%s",
                sid, self._turn,
            )

    async def _deliver(
        self,
        text: str,
        interruptible: bool,
        preemptible: bool,
        lang: str | None,
    ) -> None:
        from ..agent_runtime.runtime import resolve_live_turn_handler

        sid = self._call_sid[:6]
        runtime_mode = resolve_live_turn_handler(self._settings)
        cleaned = _sanitize_outbound_text(text, call_sid=self._call_sid)
        if not cleaned:
            await self._send_fallback(sid, interruptible, preemptible, lang)
            return

        logger.info(
            "conversationrelay_response_ready sid=%s turn=%s chars=%d runtime_mode=%s",
            sid, self._turn, len(cleaned), runtime_mode,
        )

        if getattr(self._settings, "VOICE_LOG_OUTBOUND_TEXT", True):
            safe = mask_outbound_log_text(
                cleaned,
                max_chars=getattr(self._settings, "VOICE_OUTBOUND_TEXT_MAX_LOG_CHARS", 160),
            )
            logger.debug(
                "conversationrelay_outbound_preview sid=%s text_safe=%r",
                sid, safe,
            )

        result = await send_text_to_conversation_relay(
            self._send_fn,
            cleaned,
            sid=sid,
            turn=self._turn,
            interruptible=interruptible,
            preemptible=preemptible,
            lang=lang,
            call_sid=self._call_sid,
        )

        if result.sent:
            self._stats.responses_sent += 1
            self._stats.last_outbound_type = "text"
            logger.info(
                "conversationrelay_response_sent sid=%s response_count=%d",
                sid, self._stats.responses_sent,
            )
        elif result.failed:
            await self._send_fallback(sid, interruptible, preemptible, lang)

    async def _send_fallback(
        self,
        sid: str,
        interruptible: bool,
        preemptible: bool,
        lang: str | None,
    ) -> None:
        from ..pipeline.response_guard import apply_response_guard

        fallback = apply_response_guard("", "unknown", call_sid=self._call_sid) or (
            "How can I help you with SureShot Books?"
        )
        logger.info(
            "conversationrelay_no_response sid=%s reason=fallback_guard turn=%s",
            sid, self._turn,
        )
        result = await send_text_to_conversation_relay(
            self._send_fn,
            fallback,
            sid=sid,
            turn=self._turn,
            interruptible=interruptible,
            preemptible=preemptible,
            lang=lang,
            call_sid=self._call_sid,
        )
        if result.sent:
            self._stats.responses_sent += 1
            logger.info(
                "conversationrelay_response_sent sid=%s response_count=%d",
                sid, self._stats.responses_sent,
            )

    async def flush(self) -> None:
        """Flush any buffered text at end of turn."""
        if self._buffer.strip():
            await self._deliver(
                self._buffer,
                getattr(self._settings, "VOICE_CR_TEXT_INTERRUPTIBLE", True),
                getattr(self._settings, "VOICE_CR_TEXT_PREEMPTIBLE", False),
                getattr(self._settings, "VOICE_LANGUAGE", None) or None,
            )
            self._buffer = ""
        self._streamed_any = False
