"""Central turn dispatch — routes to VOICE_OS_V2 or legacy voice_commerce_runtime."""
from __future__ import annotations

import logging
import time
from typing import Any

logger = logging.getLogger(__name__)


async def dispatch_turn(
    settings,
    session,
    user_text: str,
    send,
    caller_context,
    *,
    assembled_turn_mode: str = "",
    stt_to_turn_ms: float = 0.0,
) -> Any:
    """Route every assembled turn to the active runtime."""
    from ..observability.otel import span
    from ..voice_os_v2.runtime import RUNTIME_MODE as V2_MODE
    from ..voice_os_v2.runtime import handle_turn as v2_handle_turn
    from ..voice_os_v2.runtime import voice_os_v2_enabled

    if voice_os_v2_enabled(settings):
        sid = (session.call_sid or "")[:6]
        t0 = time.monotonic()
        logger.info(
            "voice_turn_handler sid=%s handler=%s turn_mode=%s",
            sid,
            V2_MODE,
            assembled_turn_mode or "normal",
        )
        with span("turn_processing", call_sid=sid, handler=V2_MODE):
            with span("voice_os_v2"):
                result = await v2_handle_turn(
                    session,
                    user_text,
                    send,
                    caller_context,
                    assembled_turn_mode=assembled_turn_mode,
                    stt_to_turn_ms=stt_to_turn_ms,
                )
        chars = len(getattr(result, "response_text", "") or "")
        logger.info(
            "%s_turn_completed sid=%s chars=%d total_ms=%d",
            V2_MODE,
            sid,
            chars,
            int((time.monotonic() - t0) * 1000),
        )
        return result

    from ..runtime.voice_commerce_runtime import (
        RUNTIME_MODE,
        get_voice_commerce_runtime,
        voice_commerce_enabled,
    )

    if not voice_commerce_enabled(settings):
        raise RuntimeError(
            "VOICE_COMMERCE_RUNTIME_ENABLED must be true — legacy runtimes removed"
        )

    sid = (session.call_sid or "")[:6]
    t0 = time.monotonic()

    logger.info(
        "voice_turn_handler sid=%s handler=%s turn_mode=%s",
        sid,
        RUNTIME_MODE,
        assembled_turn_mode or "normal",
    )

    with span("turn_processing", call_sid=sid, handler=RUNTIME_MODE):
        with span("voice_commerce_runtime"):
            result = await get_voice_commerce_runtime(settings).handle_turn(
                session,
                user_text,
                send,
                caller_context=caller_context,
                assembled_turn_mode=assembled_turn_mode,
                stt_to_turn_ms=stt_to_turn_ms,
            )

    chars = len(getattr(result, "response_text", "") or "")
    logger.info(
        "%s_turn_completed sid=%s chars=%d total_ms=%d",
        RUNTIME_MODE,
        sid,
        chars,
        int((time.monotonic() - t0) * 1000),
    )
    return result
