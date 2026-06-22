"""
Twilio ConversationRelay WebSocket handler.

Twilio message types received:
  setup    — call starts; contains callSid, from, to, customParameters
  prompt   — caller spoke; voicePrompt contains transcribed text; last=true when final
  dtmf     — keypad digit pressed
  interrupt — caller interrupted the agent mid-response
  error    — Twilio reports an error

Messages we send to Twilio:
  {"type": "text", "token": "...", "last": false, "interruptible": true}
    Stream text tokens; Twilio synthesises and plays them in real time.
  {"type": "text", "token": "", "last": true}
    Signal end of response; Twilio waits for next caller input.

Architecture note:
  Each prompt spawns an asyncio.Task (run_agent_turn). If the caller interrupts,
  the task is cancelled cleanly. All WebSocket sends are serialised through a
  single asyncio.Queue → sender task.

Race condition mitigation:
  The caller profile is loaded in a background task started at setup time.
  On the very first prompt, _run_turn briefly awaits that task (≤0.75 s) so
  the LLM gets returning-caller context. If the load takes longer, the call
  proceeds immediately — best-effort, never blocking. first_prompt_received is
  set before the await, which prevents the profile task from sending a greeting
  mid-conversation if it finishes late.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Optional

from fastapi import WebSocket, WebSocketDisconnect

from ..config import get_settings
from ..state.models import SessionState
from ..ai.openai_agent import run_agent_turn
from ..caller.repository import (
    get_caller_profile,
    upsert_caller_profile,
    build_safe_caller_context,
)
from ..pipeline.engine import get_engine

logger = logging.getLogger(__name__)


async def await_caller_profile_ready(
    task: Optional[asyncio.Task],
    timeout_secs: float = 0.75,
) -> None:
    """
    Briefly await a caller-profile-loading Task.

    - Returns immediately if the task is already done or None.
    - Swallows TimeoutError — the call continues without profile data.
    - Swallows all other exceptions — load failures are non-fatal.
    - Never logs secrets or raw caller data.
    """
    if task is None or task.done():
        return
    try:
        await asyncio.wait_for(asyncio.shield(task), timeout=timeout_secs)
        logger.debug("Caller profile loaded within %.2fs window", timeout_secs)
    except asyncio.TimeoutError:
        logger.debug(
            "Caller profile load timed out after %.2fs — proceeding without", timeout_secs
        )
    except Exception:
        logger.warning("Caller profile load task raised during await — continuing")


async def handle_conversation_relay(websocket: WebSocket) -> None:
    await websocket.accept()
    settings = get_settings()

    session: Optional[SessionState] = None
    current_task: Optional[asyncio.Task] = None
    call_start = time.monotonic()

    # ── Profile-loading coordination ───────────────────────────────────────────
    # profile_task: the background asyncio.Task started at setup time.
    # first_prompt_received: True once the first final prompt has been processed;
    #   set BEFORE any await so the profile task won't send a late greeting.
    # greeting_sent: True if the profile task already sent a WS greeting before
    #   the caller spoke; used to set greeted_already in SafeCallerContext.
    profile_task: Optional[asyncio.Task] = None
    first_prompt_received: bool = False
    greeting_sent: bool = False

    # All sends go through a queue → single sender task.
    send_q: asyncio.Queue[Optional[dict]] = asyncio.Queue(maxsize=512)

    async def _sender() -> None:
        try:
            while True:
                msg = await send_q.get()
                if msg is None:
                    break
                try:
                    await websocket.send_json(msg)
                except Exception as exc:
                    logger.debug("WS send error (call likely ended): %s", exc)
                    break
        except asyncio.CancelledError:
            pass

    sender_task = asyncio.create_task(_sender(), name="cr-sender")

    async def send(msg: dict) -> None:
        try:
            send_q.put_nowait(msg)
        except asyncio.QueueFull:
            logger.warning("Send queue full — dropping message: %s", msg.get("type"))

    async def _cancel_current() -> None:
        nonlocal current_task
        if current_task and not current_task.done():
            current_task.cancel()
            try:
                await asyncio.wait_for(asyncio.shield(current_task), timeout=1.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass
        current_task = None

    async def _load_caller_profile(from_number: str) -> None:
        """
        Load CallerProfile and populate safe session fields.
        Send personalised WS greeting only if the caller hasn't spoken yet.
        """
        nonlocal greeting_sent

        if not from_number or from_number == "unknown":
            session.caller_profile_loaded = True
            return
        try:
            profile = await get_caller_profile(from_number)
            if not profile:
                session.caller_profile_loaded = True
                return

            # Populate session with safe profile fields.
            session.is_returning_caller = True
            if profile.display_name:
                session.caller_name = profile.display_name
            if profile.preferred_email:
                session.caller_email = profile.preferred_email
            if profile.last_order_number:
                session.last_order_number = profile.last_order_number
            if profile.call_count:
                session.caller_call_count = profile.call_count
            if profile.last_summary:
                session.caller_last_summary = profile.last_summary

            session.caller_profile_loaded = True

            # Only greet if the caller hasn't already spoken. If the first
            # prompt already arrived (first_prompt_received=True), sending a
            # greeting now would interrupt mid-conversation — skip it instead
            # and let the LLM greet via the SafeCallerContext in its prompt.
            if not first_prompt_received:
                greeting_sent = True
                name_part = f", {profile.display_name}" if profile.display_name else ""
                greeting = (
                    f"Welcome back{name_part}! Great to hear from you again. "
                    "How can I help you today?"
                )
                await send({"type": "text", "token": greeting, "last": False, "interruptible": True})
                await send({"type": "text", "token": "", "last": True})

        except Exception:
            logger.warning(
                "Failed to load caller profile for %s",
                from_number[:4] + "***" if len(from_number) > 4 else "***",
            )
            session.caller_profile_loaded = True

    async def _run_turn(user_text: str) -> None:
        """Generate a response for one caller utterance via the pipeline engine."""
        nonlocal first_prompt_received

        # ── First turn only: briefly await the profile task ────────────────
        # Set first_prompt_received BEFORE the await so that if the profile
        # task completes during our wait it sees the flag and skips greeting.
        if not first_prompt_received:
            first_prompt_received = True
            if not session.caller_profile_loaded:
                profile_timeout_secs = settings.VOICE_FIRST_PROMPT_PROFILE_TIMEOUT_MS / 1000
                await await_caller_profile_ready(profile_task, timeout_secs=profile_timeout_secs)

        # greeting_sent is True only if the profile task greeted before the
        # caller spoke. In all other cases greeted_already=False and the LLM
        # may greet the caller in its first response.
        ctx = build_safe_caller_context(session, greeted_already=greeting_sent)

        engine = get_engine(settings)
        try:
            await engine.handle_turn(session, user_text, send, caller_context=ctx)
        except asyncio.CancelledError:
            logger.info("Turn cancelled by interrupt")

    async def _save_caller_profile() -> None:
        """Upsert CallerProfile at end of call."""
        if not session or not session.from_number or session.from_number == "unknown":
            return
        try:
            await upsert_caller_profile(
                phone_number=session.from_number,
                display_name=session.caller_name,
                preferred_email=session.caller_email,
                last_order_number=session.last_order_number,
            )
        except Exception:
            logger.warning("Failed to save caller profile")

    # ── Main receive loop ──────────────────────────────────────────────────────

    try:
        async for raw in websocket.iter_text():
            try:
                msg: dict = json.loads(raw)
            except json.JSONDecodeError:
                logger.warning("Received non-JSON frame from Twilio")
                continue

            msg_type = msg.get("type", "unknown")

            match msg_type:

                case "setup":
                    custom = msg.get("customParameters", {})
                    session = SessionState(
                        session_id=msg.get("sessionId") or str(uuid.uuid4()),
                        call_sid=msg.get("callSid", custom.get("callSid", "unknown")),
                        from_number=msg.get("from", custom.get("from", "unknown")),
                        to_number=msg.get("to", custom.get("to", "unknown")),
                        agent_id=custom.get("agentId", ""),
                        store_domain=custom.get("storeDomain", settings.SHOPIFY_SHOP_DOMAIN),
                        custom_params=custom,
                    )
                    logger.info(
                        "ConversationRelay setup | sid=%s from=%s to=%s session=%s",
                        session.call_sid,
                        session.from_number,
                        session.to_number,
                        session.session_id,
                    )
                    # Store the task handle so _run_turn can await it on turn 1.
                    profile_task = asyncio.create_task(
                        _load_caller_profile(session.from_number),
                        name="load-caller-profile",
                    )
                    # Fire-and-forget: warm local caches from Redis for this caller.
                    asyncio.create_task(
                        get_engine(settings).prefetch_on_call_setup(session),
                        name="setup-prefetch",
                    )

                case "prompt":
                    if session is None:
                        logger.warning("Received prompt before setup — ignoring")
                        continue

                    if not msg.get("last", True):
                        continue

                    voice_prompt: str = msg.get("voicePrompt", "").strip()
                    if not voice_prompt:
                        logger.debug("Empty prompt received — skipping")
                        continue

                    logger.info(
                        "Prompt | sid=%s turn=%d text=%r",
                        session.call_sid,
                        session.turn_count + 1,
                        voice_prompt[:100],
                    )

                    await _cancel_current()
                    current_task = asyncio.create_task(
                        _run_turn(voice_prompt),
                        name=f"turn-{session.turn_count + 1}",
                    )

                case "interrupt":
                    logger.info(
                        "Interrupt | sid=%s after=%sms",
                        session.call_sid if session else "?",
                        msg.get("durationUntilInterruptMs", "?"),
                    )
                    await _cancel_current()

                case "dtmf":
                    digit = msg.get("digit", "")
                    logger.debug("DTMF digit=%r sid=%s", digit, session.call_sid if session else "?")
                    if session and digit:
                        await _cancel_current()
                        current_task = asyncio.create_task(
                            _run_turn(f"(Keypad: {digit})"),
                            name="dtmf-turn",
                        )

                case "error":
                    logger.error(
                        "ConversationRelay error | sid=%s code=%s description=%s",
                        session.call_sid if session else "?",
                        msg.get("errorCode", "unknown"),
                        msg.get("description", ""),
                    )

                case _:
                    logger.debug("Unhandled Twilio CR message type: %s", msg_type)

    except WebSocketDisconnect:
        logger.info(
            "ConversationRelay WS disconnected | sid=%s duration=%.1fs",
            session.call_sid if session else "?",
            time.monotonic() - call_start,
        )
    except Exception:
        logger.exception(
            "ConversationRelay error | sid=%s",
            session.call_sid if session else "?",
        )
    finally:
        await _cancel_current()
        await _save_caller_profile()
        await send_q.put(None)
        await asyncio.gather(sender_task, return_exceptions=True)

        logger.info(
            "ConversationRelay cleanup complete | sid=%s turns=%d duration=%.1fs",
            session.call_sid if session else "?",
            session.turn_count if session else 0,
            time.monotonic() - call_start,
        )
