"""
VoiceEmitter — ElevenLabs-style sentence-level streaming with epoch-safe discard.
"""
from __future__ import annotations

import inspect
import logging
import re
from collections.abc import Awaitable, Callable
from typing import Optional, Union

from .types import EmitResult

logger = logging.getLogger(__name__)

SendFn = Callable[[dict], Awaitable[None]]
InterruptCheck = Union[Callable[[], bool], Callable[[], Awaitable[bool]]]
EpochCheck = Union[Callable[[], int], Callable[[], Awaitable[int]]]
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")


def _sentences(text: str) -> list[str]:
    cleaned = (text or "").strip()
    if not cleaned:
        return []
    parts = [p.strip() for p in _SENTENCE_SPLIT.split(cleaned) if p.strip()]
    return parts or [cleaned]


async def _call_bool(fn: InterruptCheck) -> bool:
    result = fn()
    if inspect.isawaitable(result):
        return bool(await result)
    return bool(result)


async def _call_epoch(fn: EpochCheck) -> int:
    result = fn()
    if inspect.isawaitable(result):
        return int(await result)
    return int(result)


class VoiceEmitter:
    """
    Streams full sentences to ConversationRelay.

    - Sentence-level only (no micro-chunking).
    - Discards remaining sentences when turn epoch advances or interrupt is set.
    - No tool calls — text in, WS messages out.
    """

    def __init__(self, send: SendFn, *, interruptible: bool = True):
        self._send = send
        self._interruptible = interruptible

    async def stream(
        self,
        text: str,
        *,
        turn_epoch: int,
        get_current_epoch: EpochCheck | None = None,
        is_interrupted: InterruptCheck | None = None,
    ) -> EmitResult:
        sentences = _sentences(text)
        if not sentences:
            return EmitResult(discarded=True)

        spoken_epochs: list[int] = []
        total_chars = 0

        for idx, sentence in enumerate(sentences):
            if get_current_epoch is not None:
                current = await _call_epoch(get_current_epoch)
                if current > turn_epoch:
                    logger.info(
                        "v2_emitter_discard stale_epoch=%d current=%d",
                        turn_epoch,
                        current,
                    )
                    return EmitResult(
                        spoken_epochs=spoken_epochs,
                        discarded=True,
                        chars=total_chars,
                    )

            if is_interrupted is not None and await _call_bool(is_interrupted):
                logger.info("v2_emitter_discard epoch=%d reason=interrupt_flag", turn_epoch)
                return EmitResult(
                    spoken_epochs=spoken_epochs,
                    discarded=True,
                    chars=total_chars,
                )

            is_last_sentence = idx == len(sentences) - 1
            await self._send({
                "type": "text",
                "token": sentence,
                "last": is_last_sentence,
                "interruptible": self._interruptible,
            })
            spoken_epochs.append(turn_epoch)
            total_chars += len(sentence)

        return EmitResult(spoken_epochs=spoken_epochs, chars=total_chars)
