"""
Twilio Media Streams WebSocket handler.

One call = one invocation of handle_media_stream().

Architecture:
    Twilio WS ─(µ-law frames)─► DeepgramSTT ─(STTEvents)─► StreamingOrchestrator
                                                                      │
                    ◄────────(µ-law frames via send_q)────────────────┘

Send path: all Twilio writes go through a single sender task (send_q) to avoid
concurrent WebSocket writes.

STT consumer: a background task iterates stt.events() and forwards each
STTEvent to orchestrator.on_stt_event(). This keeps the STT event loop
decoupled from the Twilio recv loop.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import uuid
from typing import Optional

from fastapi import WebSocket, WebSocketDisconnect
from openai import AsyncOpenAI

from ..core.config import get_settings
from ..pipeline.stt import DeepgramSTT
from ..pipeline.orchestrator import StreamingOrchestrator
from ..state.schema import SessionState
from ..tenant.loader import get_tenant_loader

logger = logging.getLogger(__name__)


async def handle_media_stream(websocket: WebSocket) -> None:
    await websocket.accept()
    settings = get_settings()

    stream_sid: Optional[str] = None
    call_sid: Optional[str] = None
    orchestrator: Optional[StreamingOrchestrator] = None
    stt: Optional[DeepgramSTT] = None
    stt_consumer: Optional[asyncio.Task] = None

    # All Twilio sends go through this queue → single sender task
    send_q: asyncio.Queue[str | None] = asyncio.Queue(maxsize=1024)
    sender = asyncio.create_task(_sender(websocket, send_q), name="ws-sender")

    try:
        async for raw in websocket.iter_text():
            msg: dict = json.loads(raw)
            event = msg.get("event")

            if event == "connected":
                logger.info(
                    "Media stream connected: protocol=%s", msg.get("protocol")
                )

            elif event == "start":
                stream_sid = msg["streamSid"]
                start = msg.get("start", {})
                call_sid = start.get("callSid", "unknown")
                custom = start.get("customParameters", {})
                logger.info(
                    "Stream start: sid=%s call=%s params=%s",
                    stream_sid, call_sid, custom,
                )

                loader = get_tenant_loader()
                agent_config = await loader.load_default()

                session = SessionState(
                    session_id=str(uuid.uuid4()),
                    agent_id=agent_config.agent_id,
                    tenant_id=agent_config.tenant_id,
                    call_sid=call_sid,
                    from_number=custom.get("from_number", "unknown"),
                    to_number=custom.get("to_number", "unknown"),
                )

                openai_client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)

                orchestrator = StreamingOrchestrator(
                    send_q=send_q,
                    stream_sid=stream_sid,
                    session=session,
                    agent_config=agent_config,
                    openai_client=openai_client,
                    settings=settings,
                )

                if settings.deepgram_configured:
                    stt = DeepgramSTT(api_key=settings.DEEPGRAM_API_KEY)
                    await stt.start()
                    stt_consumer = asyncio.create_task(
                        _consume_stt(stt, orchestrator), name="stt-consumer"
                    )
                else:
                    logger.warning(
                        "DEEPGRAM_API_KEY not set — STT disabled, audio discarded"
                    )

                # Greeting runs as a cancellable task inside the orchestrator
                await orchestrator.greet()

            elif event == "media":
                # Forward inbound µ-law to Deepgram (non-blocking; STT queues internally)
                if stt:
                    mulaw = base64.b64decode(msg["media"]["payload"])
                    await stt.send(mulaw)

            elif event == "mark":
                logger.debug("Mark: %s", msg.get("mark", {}).get("name"))

            elif event == "stop":
                logger.info("Stream stop: sid=%s call=%s", stream_sid, call_sid)
                break

            else:
                logger.debug("Unknown Twilio event: %s", event)

    except WebSocketDisconnect:
        logger.info("WebSocket disconnected: sid=%s", stream_sid)
    except Exception:
        logger.exception("Media stream error: sid=%s", stream_sid)
    finally:
        # Orderly shutdown: stop response → stop STT → drain sender
        if orchestrator:
            try:
                await orchestrator.close()
            except Exception:
                pass

        if stt_consumer and not stt_consumer.done():
            stt_consumer.cancel()
            await asyncio.gather(stt_consumer, return_exceptions=True)

        if stt:
            try:
                await stt.close()
            except Exception:
                pass

        await send_q.put(None)              # sentinel → sender exits cleanly
        await asyncio.gather(sender, return_exceptions=True)

        logger.info("Media stream cleanup complete: sid=%s", stream_sid)


async def _consume_stt(
    stt: DeepgramSTT, orchestrator: StreamingOrchestrator
) -> None:
    """Bridge: iterate STT events → orchestrator.on_stt_event()."""
    try:
        async for event in stt.events():
            await orchestrator.on_stt_event(event)
    except asyncio.CancelledError:
        pass
    except Exception:
        logger.exception("STT consumer error")


async def _sender(websocket: WebSocket, q: asyncio.Queue) -> None:
    """Single serialized writer: drains send_q and writes to Twilio WebSocket."""
    try:
        while True:
            msg = await q.get()
            if msg is None:
                break
            try:
                await websocket.send_text(msg)
            except Exception as exc:
                logger.debug("WS send error (call likely ended): %s", exc)
                break
    except asyncio.CancelledError:
        pass
