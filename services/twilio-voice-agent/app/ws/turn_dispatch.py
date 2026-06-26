"""Central turn dispatch — voice commerce runtime with legacy fallbacks."""
from __future__ import annotations

import logging
import time
from typing import Any, Optional

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
    """
    Route an assembled turn to the active runtime.

    Default: voice_commerce_runtime (single-brain).
    Fallback: orchestrator or llm_tool_runtime when configured.
    """
    from ..agent_runtime.llm_tool_runtime import get_llm_tool_runtime, RUNTIME_MODE as LLM_MODE
    from ..observability.otel import span
    from ..orchestrator.runtime import (
        RUNTIME_MODE as ORCH_MODE,
        get_orchestrator_runtime,
        orchestrator_enabled,
    )
    from ..runtime.voice_commerce_runtime import (
        RUNTIME_MODE as COMMERCE_MODE,
        get_voice_commerce_runtime,
        voice_commerce_enabled,
    )

    sid = (session.call_sid or "")[:6]
    use_commerce = voice_commerce_enabled(settings)
    use_orchestrator = orchestrator_enabled(settings) and not use_commerce
    if use_commerce:
        handler = COMMERCE_MODE
    elif use_orchestrator:
        handler = ORCH_MODE
    else:
        handler = LLM_MODE
    t0 = time.monotonic()

    logger.info(
        "voice_turn_handler sid=%s handler=%s turn_mode=%s",
        sid,
        handler,
        assembled_turn_mode or "normal",
    )

    with span("turn_processing", call_sid=sid, handler=handler):
        if use_commerce:
            try:
                with span("voice_commerce_runtime"):
                    result = await get_voice_commerce_runtime(settings).handle_turn(
                        session,
                        user_text,
                        send,
                        caller_context=caller_context,
                        assembled_turn_mode=assembled_turn_mode,
                        stt_to_turn_ms=stt_to_turn_ms,
                    )
            except Exception as exc:
                if getattr(settings, "VOICE_LEGACY_RUNTIME_FALLBACK_ENABLED", False):
                    logger.error(
                        "commerce_runtime_fallback sid=%s err=%s — using llm_tool_runtime",
                        sid,
                        type(exc).__name__,
                    )
                    with span("legacy_fallback"):
                        result = await get_llm_tool_runtime(settings).handle_turn(
                            session,
                            user_text,
                            send,
                            caller_context=caller_context,
                            assembled_turn_mode=assembled_turn_mode,
                        )
                    handler = f"{COMMERCE_MODE}_fallback_{LLM_MODE}"
                else:
                    raise
        elif use_orchestrator:
            try:
                with span("orchestrator"):
                    result = await get_orchestrator_runtime(settings).handle_turn(
                        session,
                        user_text,
                        send,
                        caller_context=caller_context,
                        assembled_turn_mode=assembled_turn_mode,
                        stt_to_turn_ms=stt_to_turn_ms,
                    )
            except Exception as exc:
                if getattr(settings, "VOICE_LEGACY_RUNTIME_FALLBACK_ENABLED", False):
                    logger.error(
                        "orchestrator_fallback sid=%s err=%s — using llm_tool_runtime",
                        sid,
                        type(exc).__name__,
                    )
                    with span("legacy_fallback"):
                        result = await get_llm_tool_runtime(settings).handle_turn(
                            session,
                            user_text,
                            send,
                            caller_context=caller_context,
                            assembled_turn_mode=assembled_turn_mode,
                        )
                    handler = f"{ORCH_MODE}_fallback_{LLM_MODE}"
                else:
                    raise
        else:
            with span("llm_tool_runtime"):
                result = await get_llm_tool_runtime(settings).handle_turn(
                    session,
                    user_text,
                    send,
                    caller_context=caller_context,
                    assembled_turn_mode=assembled_turn_mode,
                )

    chars = len(getattr(result, "response_text", "") or "")
    logger.info(
        "%s_turn_completed sid=%s chars=%d total_ms=%d",
        handler,
        sid,
        chars,
        int((time.monotonic() - t0) * 1000),
    )
    return result
