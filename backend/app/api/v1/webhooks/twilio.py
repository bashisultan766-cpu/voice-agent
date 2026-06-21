from __future__ import annotations
import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Form, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.database import AsyncSessionLocal, get_db
from app.config import settings
from app.core.cache import cache_get, cache_set
from app.core.encryption import decrypt
from app.models.agent import Agent
from app.models.call_log import CallLog
from app.models.conversation import ConversationTurn
from app.tools.base import ToolContext
from app.tools.registry import build_registry
from app.voice.intent import Intent, classify_intent
from app.voice.orchestrator import OrchestratorResult, ParallelVoiceOrchestrator
from app.voice.pipeline import VoicePipeline
from app.voice.deprecated_pipeline import reject_legacy_voice_pipeline
from app.integrations.twilio_client import (
    build_ack_redirect_twiml,
    build_gather_twiml,
    build_pause_redirect_twiml,
    build_say_twiml,
)

router = APIRouter()
logger = logging.getLogger("voice.webhook")

TWIML_CONTENT_TYPE = "application/xml"

# Prevent background tasks from being GC-d before completion (per-worker dict).
_active_bg_tasks: Dict[str, asyncio.Task] = {}

# Caller hears this while background processing runs (fast-ack path).
_ACK_BY_INTENT: Dict[Intent, str] = {
    Intent.PRODUCT_SEARCH: "Let me search our catalog for that.",
    Intent.ORDER_LOOKUP: "Sure, let me pull up that order for you.",
    Intent.CHECKOUT: "I'll get that set up for you.",
    Intent.RECOMMENDATION: "Let me find some great options for you.",
    Intent.EMAIL_CAPTURE: "Got it, let me update that.",
    Intent.OTHER: "One moment please.",
}
_DEFAULT_ACK = "One moment please."

# Max polling attempts in /ready before forcing a fallback response.
_MAX_READY_ATTEMPTS = 12  # 12 × 1 s pause ≈ 12 s


def _twiml_response(twiml: str) -> Response:
    return Response(content=twiml, media_type=TWIML_CONTENT_TYPE)


def _ack_for_intent(intent: Intent) -> str:
    return _ACK_BY_INTENT.get(intent, _DEFAULT_ACK)


# ── Agent resolution ──────────────────────────────────────────────────────────

async def _resolve_agent(db: AsyncSession, to_number: Optional[str]) -> Optional[Agent]:
    if not to_number:
        return None
    result = await db.execute(
        select(Agent).where(
            Agent.twilio_phone_number == to_number,
            Agent.is_active == True,
        )
    )
    return result.scalar_one_or_none()


# ── Call log helpers ──────────────────────────────────────────────────────────

async def _get_or_create_call_log(
    db: AsyncSession, call_sid: str, agent: Agent, from_number: str, to_number: str
) -> CallLog:
    result = await db.execute(select(CallLog).where(CallLog.call_sid == call_sid))
    log = result.scalar_one_or_none()
    if log:
        return log
    log = CallLog(
        id=str(uuid.uuid4()),
        agent_id=agent.id,
        tenant_id=agent.tenant_id,
        call_sid=call_sid,
        from_number=from_number,
        to_number=to_number,
        status="in_progress",
        started_at=datetime.now(timezone.utc),
    )
    db.add(log)
    await db.flush()
    return log


async def _persist_turns(
    db: AsyncSession,
    log: CallLog,
    transcript: str,
    result: Dict[str, Any],
) -> None:
    db.add(ConversationTurn(
        id=str(uuid.uuid4()),
        call_log_id=log.id,
        role="user",
        content=transcript,
    ))
    db.add(ConversationTurn(
        id=str(uuid.uuid4()),
        call_log_id=log.id,
        role="assistant",
        content=result["text"],
        tool_calls=result.get("tool_calls") or None,
        latency_ms=result.get("latency_ms"),
    ))


# ── Credential resolution + processor factory ─────────────────────────────────

def _resolve_credentials(agent: Agent) -> tuple[str, str, str]:
    """Returns (openai_key, shopify_token, resend_key)."""
    openai_key = (
        decrypt(agent.openai_api_key_enc) if agent.openai_api_key_enc
        else settings.OPENAI_API_KEY
    )
    shopify_token = decrypt(agent.shopify_api_key_enc) if agent.shopify_api_key_enc else ""
    resend_key = (
        decrypt(agent.resend_api_key_enc) if agent.resend_api_key_enc
        else settings.RESEND_API_KEY
    )
    return openai_key, shopify_token, resend_key


def _build_processor(
    agent: Agent,
    call_sid: str,
    from_number: str,
    to_number: str,
    openai_key: str,
    shopify_token: str,
    resend_key: str,
) -> ParallelVoiceOrchestrator | VoicePipeline:
    """
    Construct the turn processor.

    Both paths use ParallelVoiceOrchestrator under the hood:
    - ENABLE_PARALLEL_ORCHESTRATOR=true  → direct orchestrator (OrchestratorResult)
    - ENABLE_PARALLEL_ORCHESTRATOR=false → VoicePipeline coordinator (dict output)
    """
    tool_ctx = ToolContext(
        agent_id=agent.id,
        tenant_id=agent.tenant_id,
        call_sid=call_sid,
        shopify_store_url=agent.shopify_store_url or "",
        shopify_api_token=shopify_token,
        openai_api_key=openai_key,
        resend_api_key=resend_key,
        from_email=agent.from_email or settings.FROM_EMAIL,
    )
    registry = build_registry(agent.enabled_tools or [])
    use_openai_tts = (agent.tts_provider == "openai")

    if settings.ENABLE_PARALLEL_ORCHESTRATOR:
        return ParallelVoiceOrchestrator(
            agent_id=agent.id,
            tenant_id=agent.tenant_id,
            call_sid=call_sid,
            system_prompt=agent.system_prompt,
            tool_registry=registry,
            tool_context=tool_ctx,
            llm_model=agent.llm_model,
            tts_voice=agent.voice_id,
            openai_api_key=openai_key,
            use_openai_tts=use_openai_tts,
        )

    return VoicePipeline(
        agent_id=agent.id,
        tenant_id=agent.tenant_id,
        call_sid=call_sid,
        system_prompt=agent.system_prompt,
        tool_registry=registry,
        tool_context=tool_ctx,
        llm_model=agent.llm_model,
        tts_voice=agent.voice_id,
        openai_api_key=openai_key,
        use_openai_tts=use_openai_tts,
    )


def _normalize_result(raw: Any) -> Dict[str, Any]:
    """Coerce VoicePipeline dict or OrchestratorResult to a plain dict."""
    if isinstance(raw, OrchestratorResult):
        return raw.to_dict()
    return raw  # already a dict from VoicePipeline


def _build_response_twiml(result: Dict[str, Any], action_url: str) -> str:
    """Build TwiML <Gather> containing either <Play> (TTS audio) or <Say>."""
    audio_path = result.get("audio_path")
    if audio_path:
        audio_url = f"{settings.PUBLIC_WEBHOOK_BASE_URL}/{audio_path}"
        return build_gather_twiml(
            prompt="",
            action_url=action_url,
            play_url=audio_url,
        )
    return build_gather_twiml(
        prompt=result["text"],
        action_url=action_url,
    )


# ── Background task (fast-ack path) ──────────────────────────────────────────

async def _process_and_store(
    turn_id: str,
    agent: Agent,
    call_sid: str,
    from_number: str,
    to_number: str,
    transcript: str,
    openai_key: str,
    shopify_token: str,
    resend_key: str,
) -> None:
    """
    Background coroutine used by the fast-ack path.
    Runs the turn processor, stores the result in Redis for /ready/{turn_id},
    and persists conversation turns to the DB.
    """
    result: Dict[str, Any]
    try:
        proc = _build_processor(
            agent, call_sid, from_number, to_number,
            openai_key, shopify_token, resend_key,
        )
        try:
            raw = await asyncio.wait_for(
                proc.process_turn(transcript),
                timeout=settings.WEBHOOK_HARD_TIMEOUT_SECS,
            )
            result = _normalize_result(raw)
        except asyncio.TimeoutError:
            logger.warning("Background turn timed out", extra={"turn_id": turn_id})
            result = {
                "text": "I'm having trouble right now. Please try again.",
                "audio_path": None,
                "tool_calls": [],
                "latency_ms": int(settings.WEBHOOK_HARD_TIMEOUT_SECS * 1000),
            }

        # Persist turns with their own DB session
        async with AsyncSessionLocal() as db:
            log = await _get_or_create_call_log(db, call_sid, agent, from_number, to_number)
            await _persist_turns(db, log, transcript, result)
            await db.commit()

    except Exception as exc:
        logger.error(
            "Background turn processing failed",
            extra={"turn_id": turn_id, "error": str(exc)},
        )
        result = {
            "text": "I'm sorry, something went wrong. Please call back.",
            "audio_path": None,
            "tool_calls": [],
            "latency_ms": 0,
        }

    await cache_set(
        f"turn:result:{turn_id}",
        result,
        ttl=settings.TURN_RESULT_TTL_SECS,
    )


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/voice", dependencies=[Depends(reject_legacy_voice_pipeline)])
async def inbound_voice(
    request: Request,
    CallSid: str = Form(...),
    From: str = Form(""),
    To: str = Form(""),
    db: AsyncSession = Depends(get_db),
):
    """Initial webhook when Twilio receives an inbound call."""
    agent = await _resolve_agent(db, To)
    if not agent:
        return _twiml_response(
            build_say_twiml("Thank you for calling. This number is not currently in service.")
        )

    log = await _get_or_create_call_log(db, CallSid, agent, From, To)
    await db.commit()

    logger.info(
        "inbound_call",
        extra={"call_sid": CallSid, "agent_id": agent.id, "from": From, "to": To},
    )

    greeting = f"Hello! You've reached {agent.name}. How can I help you today?"
    action_url = f"{settings.PUBLIC_WEBHOOK_BASE_URL}/api/v1/webhooks/twilio/process"
    return _twiml_response(build_gather_twiml(prompt=greeting, action_url=action_url))


@router.post("/process", dependencies=[Depends(reject_legacy_voice_pipeline)])
async def process_speech(
    request: Request,
    CallSid: str = Form(...),
    SpeechResult: str = Form(""),
    From: str = Form(""),
    To: str = Form(""),
    Confidence: float = Form(0.0),
    db: AsyncSession = Depends(get_db),
):
    """Webhook fired after each <Gather> captures user speech.

    Two execution paths:
    ─ Synchronous (default, FAST_ACK_ENABLED=false):
        Run the turn processor inline; hard timeout at WEBHOOK_HARD_TIMEOUT_SECS.
    ─ Fast-ack (FAST_ACK_ENABLED=true):
        Return an immediate acknowledgement TwiML; launch the processor as a
        background task; Twilio polls /ready/{turn_id} for the real response.
    """
    agent = await _resolve_agent(db, To)
    if not agent:
        return _twiml_response(build_say_twiml("An error occurred. Please call back."))

    action_url = f"{settings.PUBLIC_WEBHOOK_BASE_URL}/api/v1/webhooks/twilio/process"
    transcript = SpeechResult.strip()

    if not transcript:
        return _twiml_response(
            build_gather_twiml(
                prompt="I didn't catch that. Could you please repeat?",
                action_url=action_url,
            )
        )

    logger.info(
        "speech_received",
        extra={
            "call_sid": CallSid,
            "agent_id": agent.id,
            "transcript_len": len(transcript),
            "confidence": round(Confidence, 3),
        },
    )

    openai_key, shopify_token, resend_key = _resolve_credentials(agent)

    # ── Fast-ack two-hop path ─────────────────────────────────────────────────
    if settings.FAST_ACK_ENABLED:
        turn_id = str(uuid.uuid4())
        intent_result = classify_intent(transcript)
        ack_text = _ack_for_intent(intent_result.intent)

        task = asyncio.create_task(
            _process_and_store(
                turn_id=turn_id,
                agent=agent,
                call_sid=CallSid,
                from_number=From,
                to_number=To,
                transcript=transcript,
                openai_key=openai_key,
                shopify_token=shopify_token,
                resend_key=resend_key,
            )
        )
        _active_bg_tasks[turn_id] = task
        task.add_done_callback(lambda _: _active_bg_tasks.pop(turn_id, None))

        ready_url = (
            f"{settings.PUBLIC_WEBHOOK_BASE_URL}"
            f"/api/v1/webhooks/twilio/ready/{turn_id}"
            f"?action_url={action_url}"
        )
        logger.info(
            "fast_ack_dispatched",
            extra={"turn_id": turn_id, "call_sid": CallSid, "ack_text": ack_text},
        )
        return _twiml_response(build_ack_redirect_twiml(ack_text, ready_url))

    # ── Synchronous path with hard timeout ───────────────────────────────────
    proc = _build_processor(
        agent, CallSid, From, To, openai_key, shopify_token, resend_key
    )
    try:
        raw = await asyncio.wait_for(
            proc.process_turn(transcript),
            timeout=settings.WEBHOOK_HARD_TIMEOUT_SECS,
        )
        result = _normalize_result(raw)
    except asyncio.TimeoutError:
        logger.warning(
            "webhook_timeout",
            extra={"call_sid": CallSid, "timeout": settings.WEBHOOK_HARD_TIMEOUT_SECS},
        )
        result = {
            "text": (
                "I'm having trouble right now. "
                "Please call back and I'll be happy to assist you."
            ),
            "audio_path": None,
            "tool_calls": [],
            "latency_ms": int(settings.WEBHOOK_HARD_TIMEOUT_SECS * 1000),
        }

    # Persist turns
    log = await _get_or_create_call_log(db, CallSid, agent, From, To)
    await _persist_turns(db, log, transcript, result)
    await db.commit()

    logger.info(
        "turn_complete",
        extra={
            "call_sid": CallSid,
            "latency_ms": result.get("latency_ms"),
            "response_mode": result.get("response_mode", "legacy"),
            "has_audio": bool(result.get("audio_path")),
        },
    )
    return _twiml_response(_build_response_twiml(result, action_url))


@router.post("/ready/{turn_id}", dependencies=[Depends(reject_legacy_voice_pipeline)])
async def turn_ready(
    turn_id: str,
    action_url: str = Query(
        default="",
        description="Next Gather action URL passed through from /process",
    ),
    attempt: int = Query(default=0, ge=0),
):
    """
    Polling endpoint for the fast-ack two-hop pattern.

    Twilio calls this after the acknowledgement phrase plays.
    If the background turn is done, returns the full response TwiML.
    If not, pauses 1 s and redirects back (up to _MAX_READY_ATTEMPTS times).
    """
    resolved_action_url = (
        action_url
        or f"{settings.PUBLIC_WEBHOOK_BASE_URL}/api/v1/webhooks/twilio/process"
    )
    result: Optional[Dict[str, Any]] = await cache_get(f"turn:result:{turn_id}")

    if result is not None:
        logger.info(
            "turn_ready",
            extra={"turn_id": turn_id, "attempt": attempt, "latency_ms": result.get("latency_ms")},
        )
        return _twiml_response(_build_response_twiml(result, resolved_action_url))

    if attempt >= _MAX_READY_ATTEMPTS:
        logger.warning(
            "turn_ready_timeout",
            extra={"turn_id": turn_id, "attempts": attempt},
        )
        return _twiml_response(
            build_gather_twiml(
                prompt="I'm having trouble right now. Could you repeat your question?",
                action_url=resolved_action_url,
            )
        )

    next_url = (
        f"{settings.PUBLIC_WEBHOOK_BASE_URL}"
        f"/api/v1/webhooks/twilio/ready/{turn_id}"
        f"?action_url={resolved_action_url}&attempt={attempt + 1}"
    )
    return _twiml_response(build_pause_redirect_twiml(1, next_url))


@router.post("/status", dependencies=[Depends(reject_legacy_voice_pipeline)])
async def call_status(
    CallSid: str = Form(...),
    CallStatus: str = Form(""),
    CallDuration: Optional[str] = Form(None),
    db: AsyncSession = Depends(get_db),
):
    """Twilio status callback — update call log on completion."""
    result = await db.execute(select(CallLog).where(CallLog.call_sid == CallSid))
    log = result.scalar_one_or_none()
    if log:
        log.status = CallStatus.lower()
        if CallDuration:
            log.duration_seconds = int(CallDuration)
        if CallStatus in ("completed", "failed", "busy", "no-answer"):
            log.ended_at = datetime.now(timezone.utc)
        await db.commit()
        logger.info(
            "call_ended",
            extra={
                "call_sid": CallSid,
                "status": CallStatus,
                "duration_s": CallDuration,
            },
        )
    return Response(content="", status_code=204)
