from __future__ import annotations
import uuid
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, Depends, Form, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.database import get_db
from app.config import settings
from app.models.agent import Agent
from app.models.call_log import CallLog
from app.models.conversation import ConversationTurn
from app.core.encryption import decrypt
from app.tools.base import ToolContext
from app.tools.registry import build_registry
from app.voice.pipeline import VoicePipeline
from app.integrations.twilio_client import build_gather_twiml, build_say_twiml

router = APIRouter()

TWIML_CONTENT_TYPE = "application/xml"


def _twiml_response(twiml: str) -> Response:
    return Response(content=twiml, media_type=TWIML_CONTENT_TYPE)


async def _resolve_agent(db: AsyncSession, to_number: Optional[str]) -> Optional[Agent]:
    """Find active agent by Twilio phone number."""
    if not to_number:
        return None
    result = await db.execute(
        select(Agent).where(Agent.twilio_phone_number == to_number, Agent.is_active == True)
    )
    return result.scalar_one_or_none()


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


@router.post("/voice")
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
        twiml = build_say_twiml("Thank you for calling. This number is not currently in service.")
        return _twiml_response(twiml)

    # Create call log
    log = await _get_or_create_call_log(db, CallSid, agent, From, To)
    await db.commit()

    greeting = f"Hello! You've reached {agent.name}. How can I help you today?"
    action_url = f"{settings.PUBLIC_WEBHOOK_BASE_URL}/api/v1/webhooks/twilio/process"

    twiml = build_gather_twiml(prompt=greeting, action_url=action_url)
    return _twiml_response(twiml)


@router.post("/process")
async def process_speech(
    request: Request,
    CallSid: str = Form(...),
    SpeechResult: str = Form(""),
    From: str = Form(""),
    To: str = Form(""),
    Confidence: float = Form(0.0),
    db: AsyncSession = Depends(get_db),
):
    """Webhook fired after each <Gather> captures user speech."""
    agent = await _resolve_agent(db, To)

    if not agent:
        return _twiml_response(build_say_twiml("An error occurred. Please call back."))

    transcript = SpeechResult.strip()
    if not transcript:
        action_url = f"{settings.PUBLIC_WEBHOOK_BASE_URL}/api/v1/webhooks/twilio/process"
        twiml = build_gather_twiml(
            prompt="I didn't catch that. Could you please repeat?",
            action_url=action_url,
        )
        return _twiml_response(twiml)

    # Resolve encrypted credentials
    shopify_token = decrypt(agent.shopify_api_key_enc) if agent.shopify_api_key_enc else ""
    openai_key = decrypt(agent.openai_api_key_enc) if agent.openai_api_key_enc else settings.OPENAI_API_KEY
    resend_key = decrypt(agent.resend_api_key_enc) if agent.resend_api_key_enc else settings.RESEND_API_KEY

    tool_ctx = ToolContext(
        agent_id=agent.id,
        tenant_id=agent.tenant_id,
        call_sid=CallSid,
        shopify_store_url=agent.shopify_store_url or "",
        shopify_api_token=shopify_token,
        openai_api_key=openai_key,
        resend_api_key=resend_key,
        from_email=agent.from_email or settings.FROM_EMAIL,
    )

    registry = build_registry(agent.enabled_tools or [])
    pipeline = VoicePipeline(
        agent_id=agent.id,
        tenant_id=agent.tenant_id,
        call_sid=CallSid,
        system_prompt=agent.system_prompt,
        tool_registry=registry,
        tool_context=tool_ctx,
        llm_model=agent.llm_model,
        tts_voice=agent.voice_id,
        openai_api_key=openai_key,
        use_openai_tts=(agent.tts_provider == "openai"),
    )

    result = await pipeline.process_turn(transcript)

    # Persist conversation turn
    log = await _get_or_create_call_log(db, CallSid, agent, From, To)
    turn = ConversationTurn(
        id=str(uuid.uuid4()),
        call_log_id=log.id,
        role="user",
        content=transcript,
    )
    db.add(turn)
    response_turn = ConversationTurn(
        id=str(uuid.uuid4()),
        call_log_id=log.id,
        role="assistant",
        content=result["text"],
        tool_calls=result.get("tool_calls") or None,
        latency_ms=result.get("latency_ms"),
    )
    db.add(response_turn)
    await db.commit()

    # Build TwiML response
    action_url = f"{settings.PUBLIC_WEBHOOK_BASE_URL}/api/v1/webhooks/twilio/process"

    if result.get("audio_path"):
        audio_url = f"{settings.PUBLIC_WEBHOOK_BASE_URL}/{result['audio_path']}"
        twiml = build_gather_twiml(
            prompt="",
            action_url=action_url,
            play_url=audio_url,
        )
    else:
        twiml = build_gather_twiml(
            prompt=result["text"],
            action_url=action_url,
        )

    return _twiml_response(twiml)


@router.post("/status")
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
    return Response(content="", status_code=204)
