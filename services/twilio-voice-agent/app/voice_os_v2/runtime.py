"""VOICE_AGENT_OS_V2 runtime entry — wired from turn_dispatch."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional

from .turn_controller import get_turn_controller
from .types import TurnResult

logger = logging.getLogger(__name__)

RUNTIME_MODE = "voice_os_v2.1"


@dataclass
class V2RuntimeTurnResult:
    response_text: str = ""
    end_call: bool = False
    turn_id: int = 0
    skipped: bool = False


async def handle_turn(
    legacy_session: Any,
    caller_text: str,
    send: Callable[[dict], Awaitable[None]],
    caller_context: Any = None,
    *,
    assembled_turn_mode: str = "",
    stt_to_turn_ms: float = 0.0,
) -> V2RuntimeTurnResult:
    """
    Adapter for ConversationRelay — uses legacy_session only for call metadata.
    All business state lives in Redis V2SessionState.
    """
    call_sid = getattr(legacy_session, "call_sid", "") or ""
    from_number = getattr(legacy_session, "from_number", "") or ""
    to_number = getattr(legacy_session, "to_number", "") or ""
    session_id = getattr(legacy_session, "session_id", "") or ""

    controller = get_turn_controller()
    result: TurnResult = await controller.on_user_turn(
        call_sid=call_sid,
        user_text=caller_text,
        send=send,
        from_number=from_number,
        to_number=to_number,
        session_id=session_id,
    )

    if assembled_turn_mode:
        logger.debug("v2_turn_mode=%s stt_ms=%.0f", assembled_turn_mode, stt_to_turn_ms)

    return V2RuntimeTurnResult(
        response_text=result.response_text,
        end_call=result.end_call,
        turn_id=result.turn_id,
        skipped=result.skipped,
    )


def voice_os_v2_enabled(settings=None) -> bool:
    from ..config import get_settings

    s = settings or get_settings()
    return bool(getattr(s, "VOICE_OS_V2_ENABLED", False))
