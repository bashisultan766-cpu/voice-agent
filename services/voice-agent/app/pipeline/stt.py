"""
Streaming STT — Deepgram Nova-2 provider (raw WebSocket, mulaw 8 kHz).

Requires websockets >= 12 (ships with uvicorn[standard] >= 0.32).

Barge-in note: when DeepgramSTT emits an STTEvent with speech_started=True while
TTS is playing, the caller must invoke tts_provider.cancel() immediately.
"""
from __future__ import annotations

import asyncio
import json
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import AsyncIterator
from urllib.parse import urlencode

import websockets
import websockets.exceptions

logger = logging.getLogger(__name__)

_DEEPGRAM_WS = "wss://api.deepgram.com/v1/listen"


@dataclass
class STTEvent:
    text: str
    is_final: bool
    confidence: float = 0.0
    speech_final: bool = False      # triggers LLM turn
    speech_started: bool = False    # barge-in signal


class STTProvider(ABC):
    """Base contract for streaming STT providers.

    Concrete classes also expose:
        async def events(self) -> AsyncIterator[STTEvent]   # async generator
    """

    @abstractmethod
    async def start(self) -> None:
        """Open the STT connection."""

    @abstractmethod
    async def send(self, mulaw_bytes: bytes) -> None:
        """Feed a raw 8 kHz µ-law audio chunk."""

    @abstractmethod
    async def close(self) -> None:
        """Flush remaining transcripts and close the connection."""


class DeepgramSTT(STTProvider):
    """
    Streams 8 kHz µ-law audio to Deepgram Nova-2 and surfaces events via
    an async-generator interface.

    Usage:
        stt = DeepgramSTT(api_key=settings.DEEPGRAM_API_KEY)
        await stt.start()
        async with asyncio.TaskGroup() as tg:
            tg.create_task(_feed_audio(stt))     # calls stt.send() in a loop
            tg.create_task(_handle_events(stt))  # iterates stt.events()
        await stt.close()
    """

    _PARAMS: dict[str, str] = {
        "model": "nova-2",
        "encoding": "mulaw",
        "sample_rate": "8000",
        "channels": "1",
        "interim_results": "true",
        "utterance_end_ms": "1000",
        "vad_events": "true",
        "smart_format": "true",
    }

    def __init__(self, api_key: str) -> None:
        self._api_key = api_key
        self._ws = None
        self._queue: asyncio.Queue[STTEvent | None] = asyncio.Queue()
        self._recv_task: asyncio.Task | None = None
        self._closed = False

    async def start(self) -> None:
        url = f"{_DEEPGRAM_WS}?{urlencode(self._PARAMS)}"
        self._ws = await websockets.connect(
            url,
            additional_headers={"Authorization": f"Token {self._api_key}"},
            ping_interval=10,
            ping_timeout=20,
        )
        logger.info("Deepgram STT connected (nova-2, mulaw 8 kHz)")
        self._recv_task = asyncio.create_task(self._recv_loop(), name="dg-recv")

    async def send(self, mulaw_bytes: bytes) -> None:
        if self._ws and not self._closed:
            await self._ws.send(mulaw_bytes)

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._ws:
            try:
                # Ask Deepgram to flush and finalize any in-progress transcript.
                await self._ws.send(json.dumps({"type": "CloseStream"}))
                await asyncio.sleep(0.4)
            except Exception:
                pass
            try:
                await self._ws.close()
            except Exception:
                pass
        if self._recv_task:
            self._recv_task.cancel()
            try:
                await self._recv_task
            except asyncio.CancelledError:
                pass
        await self._queue.put(None)  # unblock events() consumer

    async def events(self) -> AsyncIterator[STTEvent]:
        """Yield STTEvents until the connection closes or close() is called."""
        while True:
            ev = await self._queue.get()
            if ev is None:
                return
            yield ev

    # ── internal ──────────────────────────────────────────────────────────────

    async def _recv_loop(self) -> None:
        try:
            async for raw in self._ws:
                ev = _parse_message(raw)
                if ev is not None:
                    await self._queue.put(ev)
        except (websockets.exceptions.ConnectionClosed, asyncio.CancelledError):
            pass
        except Exception:
            logger.exception("Deepgram recv error")
        finally:
            await self._queue.put(None)


def _parse_message(raw: str | bytes) -> STTEvent | None:
    """Parse one Deepgram JSON frame into an STTEvent, or None if not actionable."""
    if not isinstance(raw, str):
        return None
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        return None

    match msg.get("type"):
        case "SpeechStarted":
            return STTEvent(text="", is_final=False, speech_started=True)

        case "Results":
            alts = msg.get("channel", {}).get("alternatives", [])
            if not alts:
                return None
            alt = alts[0]
            text = alt.get("transcript", "").strip()
            if not text:
                return None
            return STTEvent(
                text=text,
                is_final=msg.get("is_final", False),
                confidence=alt.get("confidence", 0.0),
                speech_final=msg.get("speech_final", False),
            )

        case "UtteranceEnd":
            # Deepgram signals utterance boundary even if speech_final hasn't fired.
            return STTEvent(text="", is_final=True, speech_final=True)

        case _:
            return None
