"""Twilio Media Streams WebSocket handler."""
from __future__ import annotations

import asyncio
import base64
import json
import logging
from typing import Optional

from fastapi import WebSocket, WebSocketDisconnect

from ..core.config import get_settings
from ..pipeline.audio import chunk_for_twilio, pcm16_to_mulaw

logger = logging.getLogger(__name__)

_GREETING = (
    "Hello, thank you for calling SureShot Books! "
    "My name is Alex, and I'm here to help you find books, "
    "check on an order, or anything else you need. "
    "How can I help you today?"
)


async def handle_media_stream(websocket: WebSocket) -> None:
    """
    Manage a single Twilio Media Streams WebSocket session.

    Milestone 2 lifecycle:
        connected  → log protocol
        start      → capture stream_sid / call_sid, fire greeting TTS
        media      → ignore (Milestone 3 wires this to Deepgram STT)
        mark       → log Twilio echo (Milestone 3 uses for barge-in timing)
        stop       → clean up and close
    """
    await websocket.accept()
    settings = get_settings()

    stream_sid: Optional[str] = None
    call_sid: Optional[str] = None
    greeting_task: Optional[asyncio.Task] = None

    try:
        async for raw in websocket.iter_text():
            msg: dict = json.loads(raw)
            event = msg.get("event")

            if event == "connected":
                logger.info("Media stream connected: protocol=%s", msg.get("protocol"))

            elif event == "start":
                stream_sid = msg["streamSid"]
                start_data = msg.get("start", {})
                call_sid = start_data.get("callSid", "unknown")
                custom = start_data.get("customParameters", {})
                logger.info(
                    "Stream started: stream_sid=%s call_sid=%s custom=%s",
                    stream_sid, call_sid, custom,
                )
                greeting_task = asyncio.create_task(
                    _send_greeting(websocket, stream_sid, settings)
                )

            elif event == "media":
                # Consume without processing — keeps the WS responsive.
                # Milestone 3 will pipe msg["media"]["payload"] into Deepgram STT.
                pass

            elif event == "mark":
                name = msg.get("mark", {}).get("name", "")
                logger.debug("Mark echoed by Twilio: %s", name)
                # Milestone 3: "greeting-done" triggers the STT listening window.

            elif event == "stop":
                logger.info("Stream stopped: stream_sid=%s call_sid=%s", stream_sid, call_sid)
                break

            else:
                logger.debug("Unknown WS event: %s", event)

    except WebSocketDisconnect:
        logger.info("WebSocket disconnected: stream_sid=%s", stream_sid)
    except Exception:
        logger.exception(
            "Media stream error: stream_sid=%s call_sid=%s", stream_sid, call_sid
        )
    finally:
        if greeting_task and not greeting_task.done():
            greeting_task.cancel()
            try:
                await greeting_task
            except asyncio.CancelledError:
                pass


async def _send_greeting(websocket: WebSocket, stream_sid: str, settings) -> None:
    """Synthesize greeting with OpenAI TTS (PCM) and stream back as 8 kHz µ-law frames."""
    try:
        from openai import AsyncOpenAI

        client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
        response = await client.audio.speech.create(
            model=settings.OPENAI_TTS_MODEL,
            voice=settings.OPENAI_TTS_VOICE,
            input=_GREETING,
            response_format="pcm",  # 24 kHz, 16-bit, mono — no container overhead
        )
        pcm_bytes: bytes = response.content

        await _stream_audio(websocket, stream_sid, pcm_bytes, src_rate=24000)
        await _send_mark(websocket, stream_sid, "greeting-done")

        logger.info(
            "Greeting sent: stream_sid=%s pcm_bytes=%d chars=%d",
            stream_sid, len(pcm_bytes), len(_GREETING),
        )

    except asyncio.CancelledError:
        raise  # caller is shutting down — don't swallow
    except Exception:
        logger.exception("Greeting synthesis failed: stream_sid=%s", stream_sid)


async def _stream_audio(
    websocket: WebSocket,
    stream_sid: str,
    pcm_bytes: bytes,
    src_rate: int = 24000,
) -> None:
    """Convert PCM → 8 kHz µ-law, then send one Twilio media message per 20 ms frame."""
    mulaw = pcm16_to_mulaw(pcm_bytes, src_rate=src_rate)
    for chunk in chunk_for_twilio(mulaw):
        payload = base64.b64encode(chunk).decode()
        await websocket.send_text(
            json.dumps({
                "event": "media",
                "streamSid": stream_sid,
                "media": {"payload": payload},
            })
        )


async def _send_mark(websocket: WebSocket, stream_sid: str, name: str) -> None:
    """
    Send a Twilio mark event.
    Twilio echoes it back once all queued audio before the mark has finished playing.
    Used in Milestone 3 to open the STT listen window after the greeting finishes.
    """
    await websocket.send_text(
        json.dumps({
            "event": "mark",
            "streamSid": stream_sid,
            "mark": {"name": name},
        })
    )
