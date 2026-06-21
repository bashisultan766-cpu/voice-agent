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
import time
import uuid
from typing import Optional

from fastapi import WebSocket, WebSocketDisconnect
from openai import AsyncOpenAI

from ..core.config import get_settings
from ..pipeline.call_debug import call_log
from ..pipeline.stt import DeepgramSTT
from ..pipeline.orchestrator import StreamingOrchestrator
from ..state.schema import SessionState
from ..tenant.loader import get_tenant_loader

logger = logging.getLogger(__name__)

_STT_NO_TRANSCRIPT_S = 3.0


async def handle_media_stream(websocket: WebSocket) -> None:
    await websocket.accept()
    settings = get_settings()

    stream_sid: Optional[str] = None
    call_sid: Optional[str] = None
    from_number = "unknown"
    to_number = "unknown"
    orchestrator: Optional[StreamingOrchestrator] = None
    stt: Optional[DeepgramSTT] = None
    stt_consumer: Optional[asyncio.Task] = None
    stt_watchdog: Optional[asyncio.Task] = None
    media_frame_count = 0
    first_media_at: float | None = None
    close_reason = "unknown"

    # All Twilio sends go through this queue → single sender task
    send_q: asyncio.Queue[str | None] = asyncio.Queue(maxsize=1024)
    outbound_ws_messages = [0]
    sender = asyncio.create_task(
        _sender(websocket, send_q, outbound_ws_messages),
        name="ws-sender",
    )

    async def _stt_no_transcript_watchdog() -> None:
        while True:
            await asyncio.sleep(0.5)
            if orchestrator is None:
                continue
            if orchestrator.transcript_seen:
                return
            if first_media_at is None or media_frame_count == 0:
                continue
            if time.monotonic() - first_media_at >= _STT_NO_TRANSCRIPT_S:
                call_log(
                    "no_transcript_timeout",
                    media_frame_count=media_frame_count,
                    call_sid=call_sid,
                    seconds=_STT_NO_TRANSCRIPT_S,
                )
                await orchestrator.handle_stt_no_transcript()
                return

    try:
        async for raw in websocket.iter_text():
            msg: dict = json.loads(raw)
            event = msg.get("event")

            if event == "connected":
                call_log("stream_connected", protocol=msg.get("protocol"))

            elif event == "start":
                stream_sid = msg["streamSid"]
                start = msg.get("start", {})
                call_sid = start.get("callSid", "unknown")
                custom = start.get("customParameters", {})
                from_number = custom.get("from_number", start.get("from", "unknown"))
                to_number = custom.get("to_number", start.get("to", "unknown"))
                call_log(
                    "stream_start",
                    stream_sid=stream_sid,
                    call_sid=call_sid,
                    from_number=from_number,
                    to_number=to_number,
                    custom_params=custom,
                )

                loader = get_tenant_loader()
                agent_config = await loader.load_default()

                session = SessionState(
                    session_id=str(uuid.uuid4()),
                    agent_id=agent_config.agent_id,
                    tenant_id=agent_config.tenant_id,
                    call_sid=call_sid,
                    from_number=from_number,
                    to_number=to_number,
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
                    stt_watchdog = asyncio.create_task(
                        _stt_no_transcript_watchdog(), name="stt-watchdog"
                    )
                else:
                    logger.warning(
                        "DEEPGRAM_API_KEY not set — STT disabled, audio discarded"
                    )

                await orchestrator.greet()

            elif event == "media":
                if stt:
                    mulaw = base64.b64decode(msg["media"]["payload"])
                    await stt.send(mulaw)
                media_frame_count += 1
                if first_media_at is None:
                    first_media_at = time.monotonic()
                if media_frame_count % 50 == 0:
                    call_log(
                        "media_frame_count",
                        count=media_frame_count,
                        call_sid=call_sid,
                        stream_sid=stream_sid,
                    )

            elif event == "mark":
                logger.debug("Mark: %s", msg.get("mark", {}).get("name"))

            elif event == "stop":
                close_reason = "twilio_stop"
                call_log(
                    "stream_stop",
                    stream_sid=stream_sid,
                    call_sid=call_sid,
                    media_frame_count=media_frame_count,
                )
                break

            else:
                logger.debug("Unknown Twilio event: %s", event)

    except WebSocketDisconnect:
        close_reason = "websocket_disconnect"
        call_log("websocket_close", reason=close_reason, stream_sid=stream_sid, call_sid=call_sid)
    except Exception as exc:
        close_reason = f"error:{exc}"
        call_log("websocket_close", reason=close_reason, stream_sid=stream_sid, call_sid=call_sid)
        logger.exception("Media stream error: sid=%s", stream_sid)
    finally:
        if stt_watchdog and not stt_watchdog.done():
            stt_watchdog.cancel()
            await asyncio.gather(stt_watchdog, return_exceptions=True)

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

        await send_q.put(None)
        await asyncio.gather(sender, return_exceptions=True)

        call_log(
            "stream_cleanup_complete",
            stream_sid=stream_sid,
            call_sid=call_sid,
            close_reason=close_reason,
            media_frame_count=media_frame_count,
            outbound_ws_messages=outbound_ws_messages[0],
            outbound_audio_chunks=getattr(orchestrator, "_outbound_audio_chunks", 0)
            if orchestrator
            else 0,
        )


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


async def _sender(
    websocket: WebSocket,
    q: asyncio.Queue,
    outbound_counter: list[int],
) -> None:
    """Single serialized writer: drains send_q and writes to Twilio WebSocket."""
    try:
        while True:
            msg = await q.get()
            if msg is None:
                break
            try:
                await websocket.send_text(msg)
                outbound_counter[0] += 1
            except Exception as exc:
                logger.debug("WS send error (call likely ended): %s", exc)
                break
    except asyncio.CancelledError:
        pass
