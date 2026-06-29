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
from ..state.session_store import load_call_resume_by_phone, save_call_resume_by_phone
from ..conversation.call_memory import (
    apply_resume_from_stored_data,
    get_resume_greeting,
    store_resume_snapshot,
)
from ..caller.repository import (
    get_caller_profile,
    upsert_caller_profile,
    build_safe_caller_context,
)
from ..agent_runtime.live_runtime import resolve_live_turn_handler
from ..sync.call_setup_prefetch import prefetch_on_call_setup
from ..voice.turn_assembler import clear_turn_assembler, get_turn_assembler
from .conversation_relay_sender import ConversationRelayOutbound, ConversationRelayStats

logger = logging.getLogger(__name__)


def _mask_phone(number: str) -> str:
    """Return last-4 masked phone: ***7890. Safe for all log lines."""
    digits = "".join(c for c in (number or "") if c.isdigit())
    if len(digits) >= 4:
        return f"***{digits[-4:]}"
    return "***"


async def dispatch_assembled_turn(
    settings,
    session: SessionState,
    user_text: str,
    send,
    caller_context,
    *,
    assembled_turn_mode: str = "",
    stt_to_turn_ms: float = 0.0,
) -> None:
    """
    Route one assembled ConversationRelay turn through central dispatch.

    Default path: orchestrator (supervisor → planner → tools → composer).
    When VOICE_ORCHESTRATOR_ENABLED=false, falls back to llm_tool_runtime.
    When orchestrator raises and VOICE_LEGACY_RUNTIME_FALLBACK_ENABLED=true,
    dispatch falls back to llm_tool_runtime for this release.
    """
    from ..agent_runtime.llm_tool_runtime import RUNTIME_MODE as LLM_MODE
    from ..orchestrator.runtime import RUNTIME_MODE as ORCH_MODE, orchestrator_enabled
    from .turn_dispatch import dispatch_turn

    sid = session.call_sid[:6]
    configured = settings.VOICE_AGENT_RUNTIME_MODE
    use_orchestrator = orchestrator_enabled(settings)
    handler = ORCH_MODE if use_orchestrator else LLM_MODE

    if configured not in (LLM_MODE, ORCH_MODE) and configured != handler:
        logger.warning(
            "legacy_runtime_mode_ignored sid=%s configured=%s using=%s",
            sid, configured, handler,
        )

    result = await dispatch_turn(
        settings,
        session,
        user_text,
        send,
        caller_context,
        assembled_turn_mode=assembled_turn_mode,
        stt_to_turn_ms=stt_to_turn_ms,
    )
    if getattr(result, "end_call", False):
        await send({"type": "end", "handoffData": '{"reason":"caller_done"}'})


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
    from ..observability.otel import span

    settings = get_settings()
    with span("inbound_call"):
        await _handle_conversation_relay_inner(websocket, settings)


async def _handle_conversation_relay_inner(websocket: WebSocket, settings) -> None:
    from ..observability.otel import span

    if settings.WS_TOKEN_VALIDATION_ENABLED and settings.ws_token_secret:
        from ..security.rate_limit import check_rate_limit
        from ..security.ws_token import validate_ws_token

        token = websocket.query_params.get("token", "")
        payload = validate_ws_token(token)
        if not payload:
            await websocket.close(code=4401, reason="Invalid or expired WebSocket token")
            return
        call_key = str(payload.get("callSid", ""))[:16]
        allowed = await check_rate_limit(
            f"ws_setup:{call_key}",
            limit=30,
            window_sec=60,
        )
        if not allowed:
            await websocket.close(code=4429, reason="Rate limit exceeded")
            return

    await websocket.accept()

    with span("websocket_session"):
        await _run_conversation_relay_session(websocket, settings)


async def _run_conversation_relay_session(websocket: WebSocket, settings) -> None:
    call_start = time.monotonic()

    session: Optional[SessionState] = None
    current_task: Optional[asyncio.Task] = None

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
    cr_stats = ConversationRelayStats()
    outbound: Optional[ConversationRelayOutbound] = None

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

    async def _queue_send(msg: dict) -> None:
        try:
            send_q.put_nowait(msg)
        except asyncio.QueueFull:
            logger.warning("Send queue full — dropping message: %s", msg.get("type"))

    async def send(msg: dict) -> None:
        """Engine/runtime send callback — routes through CR outbound adapter."""
        if outbound is not None:
            await outbound.engine_send(msg)
        else:
            await _queue_send(msg)

    async def _cancel_current() -> None:
        nonlocal current_task
        if current_task and not current_task.done():
            from ..agent_runtime.interruption_manager import record_interrupt
            from ..agent_runtime.conversation_state_machine import record_interrupt as record_sm_interrupt
            prev_intent = ""
            prev_response = ""
            if session is not None:
                dec = getattr(session, "last_supervisor_decision", None)
                if dec:
                    prev_intent = getattr(dec, "user_intent", "") or ""
                mem = getattr(session, "call_memory", None)
                if mem and getattr(mem, "assistant_turns", None):
                    prev_response = mem.assistant_turns[-1] if mem.assistant_turns else ""
                record_interrupt(
                    session.call_sid,
                    previous_intent=prev_intent,
                    previous_response=prev_response,
                )
                record_sm_interrupt(session.call_sid)
                from ..agents.openai_request_utils import rollback_interrupted_turn

                session.history = rollback_interrupted_turn(list(session.history or []))
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
            if profile:
                # Populate session with safe profile fields.
                session.is_returning_caller = True
                if profile.display_name:
                    from ..dialogue.greeting import greeting_safe_name

                    safe = greeting_safe_name(profile.display_name)
                    if safe:
                        session.caller_name = safe
                if profile.preferred_email:
                    session.caller_email = profile.preferred_email
                if profile.last_order_number:
                    session.last_order_number = profile.last_order_number
                if profile.call_count:
                    session.caller_call_count = profile.call_count
                if profile.last_summary:
                    session.caller_last_summary = profile.last_summary

            # Caller identity (cache + optional live Shopify) for greeting name
            # and recent-order summary — friendly recognition only, not verification.
            try:
                from ..agent_runtime.caller_identity import apply_to_session, get_caller_info

                identity = await get_caller_info(from_number, allow_live=True)
                apply_to_session(session, identity)
            except Exception:
                logger.debug("caller_identity_prefetch_failed sid=%s", session.call_sid[:6])

            session.caller_profile_loaded = True

            # v4.6: TwiML already spoke SureShot greeting — do not duplicate via WS.
            # Returning-caller welcome-back is handled in TwiML or first composer turn.
            if not first_prompt_received:
                greeting_sent = True

        except Exception:
            logger.warning(
                "Failed to load caller profile for %s", _mask_phone(from_number)
            )
            session.caller_profile_loaded = True

    async def _run_turn(user_text: str, turn_mode: str = "normal") -> None:
        """Generate a response for one caller utterance via the pipeline engine."""
        nonlocal first_prompt_received

        if session is None:
            return

        session.voice_interrupted = False
        session.tool_progress_sent_for_op = ""
        session.turn_count += 1
        if outbound is not None:
            outbound.set_turn(session.turn_count)

        # ── First turn only: briefly await the profile task ────────────────
        if not first_prompt_received:
            first_prompt_received = True
            if not session.caller_profile_loaded:
                profile_timeout_secs = settings.VOICE_FIRST_PROMPT_PROFILE_TIMEOUT_MS / 1000
                await await_caller_profile_ready(profile_task, timeout_secs=profile_timeout_secs)

        greeted = greeting_sent or getattr(session, "twiml_greeting_spoken", False)
        ctx = build_safe_caller_context(session, greeted_already=greeted)

        try:
            await dispatch_assembled_turn(
                settings,
                session,
                user_text,
                send,
                ctx,
                assembled_turn_mode=turn_mode,
            )
        except asyncio.CancelledError:
            logger.info("Turn cancelled by interrupt")
            raise
        finally:
            if outbound is not None:
                await outbound.flush()

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
                        twiml_greeting_spoken=True,
                    )
                    outbound = ConversationRelayOutbound(
                        _queue_send, settings, session.call_sid, cr_stats,
                    )
                    logger.info(
                        "ConversationRelay setup | sid=%s from=%s to=%s session=%s",
                        session.call_sid,
                        _mask_phone(session.from_number),
                        _mask_phone(session.to_number),
                        session.session_id,
                    )
                    logger.info(
                        "voice_runtime_selected sid=%s env_mode=%s handler=%s",
                        session.call_sid[:6],
                        settings.VOICE_AGENT_RUNTIME_MODE,
                        resolve_live_turn_handler(settings),
                    )
                    # v4.8: resume prior call context if caller reconnected within window
                    try:
                        prior_data = await load_call_resume_by_phone(session.from_number)
                        if prior_data:
                            if apply_resume_from_stored_data(
                                session,
                                prior_data,
                                resume_window_minutes=settings.CALL_RESUME_WINDOW_MINUTES,
                            ):
                                session.resume_greeting = get_resume_greeting()
                                session.resume_greeting_pending = True
                                session.resume_context_available = True
                                session.resume_greeting_delivered = False
                                logger.info(
                                    "call_resume_detected sid=%s from=%s",
                                    session.call_sid[:6],
                                    _mask_phone(session.from_number),
                                )
                    except Exception:
                        logger.warning(
                            "call_resume_load_failed sid=%s",
                            session.call_sid[:6],
                        )
                    # Store the task handle so _run_turn can await it on turn 1.
                    profile_task = asyncio.create_task(
                        _load_caller_profile(session.from_number),
                        name="load-caller-profile",
                    )
                    # Fire-and-forget: warm local caches from Redis for this caller.
                    asyncio.create_task(
                        prefetch_on_call_setup(session),
                        name="setup-prefetch",
                    )
                    from ..memory.postgres_store import persist_call_session_if_configured
                    from ..workflow.hooks import schedule_workflow_event

                    persist_call_session_if_configured(session, status="active")
                    schedule_workflow_event(
                        session,
                        "call_started",
                        {"call_sid_tail": (session.call_sid or "")[-6:]},
                    )

                case "prompt":
                    if session is None:
                        logger.warning("Received prompt before setup — ignoring")
                        continue

                    is_last = msg.get("last", True)
                    cr_stats.prompts_received += 1
                    logger.info(
                        "conversationrelay_prompt_received sid=%s prompt_count=%d last=%s",
                        session.call_sid[:6],
                        cr_stats.prompts_received,
                        is_last,
                    )

                    if not is_last:
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

                    assembler = get_turn_assembler(session.call_sid, settings)

                    async def _emit_assembled(turn) -> None:
                        nonlocal current_task
                        from ..voice.turn_assembler import AssembledTurn

                        if isinstance(turn, str):
                            turn = AssembledTurn(text=turn, mode="normal")
                        cr_stats.assembled_turns += 1
                        logger.info(
                            "conversationrelay_assembled_turn sid=%s assembled_count=%d mode=%s",
                            session.call_sid[:6],
                            cr_stats.assembled_turns,
                            turn.mode,
                        )
                        await _cancel_current()
                        current_task = asyncio.create_task(
                            _run_turn(turn.text, turn.mode),
                            name=f"turn-{session.turn_count + 1}",
                        )

                    await assembler.ingest(
                        voice_prompt,
                        _emit_assembled,
                        call_sid=session.call_sid,
                        pending_isbn_buffer=getattr(session, "pending_isbn_buffer", "") or "",
                    )

                case "interrupt":
                    logger.info(
                        "Interrupt | sid=%s after=%sms",
                        session.call_sid if session else "?",
                        msg.get("durationUntilInterruptMs", "?"),
                    )
                    if session is not None:
                        session.voice_interrupted = True
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
                    desc = msg.get("description", "")
                    logger.error(
                        "conversationrelay_error sid=%s description=%s last_outbound=%s",
                        session.call_sid[:6] if session else "?",
                        desc,
                        cr_stats.last_outbound_type or "none",
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
        if session is not None:
            try:
                store_resume_snapshot(session)
                await save_call_resume_by_phone(
                    session.from_number,
                    {
                        "call_sid": session.call_sid,
                        "call_ended_at": session.call_ended_at,
                        "snapshot": session.call_resume_snapshot,
                    },
                    ttl=settings.CALL_RESUME_WINDOW_MINUTES * 120,
                )
            except Exception:
                logger.warning(
                    "call_resume_store_failed sid=%s",
                    session.call_sid[:6] if session else "?",
                )
            try:
                from ..memory.postgres_store import persist_call_session_if_configured
                from ..workflow.hooks import schedule_workflow_event

                schedule_workflow_event(session, "call_ended", {})
                persist_call_session_if_configured(session, status="ended", ended=True)
            except Exception:
                logger.debug("postgres_call_end_skipped")
            try:
                from ..analytics.post_call import finalize_call_analytics

                asyncio.create_task(
                    finalize_call_analytics(session),
                    name="post-call-analytics",
                )
            except Exception:
                logger.debug("post_call_analytics_schedule_skipped")
        await _save_caller_profile()
        if session is not None:
            clear_turn_assembler(session.call_sid)
            from ..agent_runtime.conversation_state_machine import clear_conversation_state
            from ..agent_runtime.interruption_manager import clear_interrupt_context
            clear_conversation_state(session.call_sid)
            clear_interrupt_context(session.call_sid)
        await send_q.put(None)
        await asyncio.gather(sender_task, return_exceptions=True)

        logger.info(
            "ConversationRelay cleanup complete | sid=%s turns=%d "
            "prompts_received=%d assembled_turns=%d responses_sent=%d duration=%.1fs",
            session.call_sid if session else "?",
            session.turn_count if session else 0,
            cr_stats.prompts_received,
            cr_stats.assembled_turns,
            cr_stats.responses_sent,
            time.monotonic() - call_start,
        )
