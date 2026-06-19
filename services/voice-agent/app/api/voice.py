import logging
from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, Form, HTTPException, Query, Request, Response

from ..voice.pipeline import VoicePipeline
from ..voice.twiml import gather_twiml, media_stream_twiml, reject_twiml
from ..config import get_settings

router = APIRouter(prefix="/voice", tags=["voice"])
logger = logging.getLogger(__name__)

_pipeline: Optional[VoicePipeline] = None


def _get_pipeline() -> VoicePipeline:
    global _pipeline
    if _pipeline is None:
        _pipeline = VoicePipeline()
    return _pipeline


# ── Twilio webhook signature validation ───────────────────────────────────────

async def _twilio_signature_guard(request: Request) -> None:
    """
    Verify the X-Twilio-Signature header on every inbound webhook.
    Raises 403 when TWILIO_VALIDATE_REQUESTS=true and the signature is invalid.
    Set TWILIO_VALIDATE_REQUESTS=false in local dev (ngrok URLs change per session).
    """
    settings = get_settings()
    if not settings.TWILIO_VALIDATE_REQUESTS:
        return

    from twilio.request_validator import RequestValidator

    validator = RequestValidator(settings.TWILIO_AUTH_TOKEN)

    # Reconstruct the URL exactly as Twilio signed it.
    # BASE_URL is the public-facing HTTPS URL Twilio actually called.
    base = settings.BASE_URL.rstrip("/")
    path = request.url.path
    query = ("?" + str(request.url.query)) if request.url.query else ""
    url = f"{base}{path}{query}"

    # Starlette caches request.form() after first call — safe to read here
    # and again implicitly via Form(...) params on the route handler.
    form = await request.form()
    params = dict(form.multi_items())

    signature = request.headers.get("X-Twilio-Signature", "")
    if not validator.validate(url, params, signature):
        logger.warning("Invalid Twilio signature rejected for %s", url)
        raise HTTPException(status_code=403, detail="Invalid Twilio webhook signature")


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/test")
async def voice_test() -> dict[str, Any]:
    """Smoke-test endpoint — confirms the router is reachable."""
    return {
        "status": "ok",
        "message": "Voice agent API is reachable",
        "webhooks": {
            "incoming": "/voice/incoming",
            "gather": "/voice/gather",
            "status": "/voice/status",
            "ws": "/ws/stream",
        },
    }


@router.post("/incoming", dependencies=[Depends(_twilio_signature_guard)])
async def incoming_call(
    CallSid: str = Form(...),
    From: str = Form(...),
    To: str = Form(...),
) -> Response:
    """
    Twilio webhook: new inbound call.
    Returns <Connect><Stream> TwiML to open a Media Streams WebSocket.
    The WebSocket handler (app/ws/media_stream.py) takes over from here.
    """
    settings = get_settings()
    logger.info("Incoming call (Media Streams): sid=%s from=%s to=%s", CallSid, From, To)
    twiml = media_stream_twiml(settings.BASE_URL)
    return Response(content=twiml, media_type="application/xml")


@router.post("/gather")
async def gather(
    session: str = Query(...),
    CallSid: str = Form(...),
    SpeechResult: str = Form(default=""),
    Confidence: float = Form(default=0.0),
) -> Response:
    """Twilio webhook: speech result from <Gather>."""
    speech = SpeechResult.strip()
    logger.info("Gather: session=%s text=%r conf=%.2f", session, speech[:80], Confidence)

    if not speech:
        # No speech — re-prompt with the same gather
        settings = get_settings()
        gather_url = f"{settings.BASE_URL}/voice/gather?session={session}"
        twiml = gather_twiml(action_url=gather_url)
        return Response(content=twiml, media_type="application/xml")

    try:
        twiml = await _get_pipeline().handle_turn(
            session_id=session,
            speech_text=speech,
            call_sid=CallSid,
        )
    except Exception:
        logger.exception("Error processing turn session=%s", session)
        settings = get_settings()
        gather_url = f"{settings.BASE_URL}/voice/gather?session={session}"
        twiml = gather_twiml(action_url=gather_url)

    return Response(content=twiml, media_type="application/xml")


@router.post("/status")
async def call_status(
    CallSid: str = Form(...),
    CallStatus: str = Form(...),
) -> Response:
    """Twilio status callback: call completed / failed."""
    logger.info("Call status: sid=%s status=%s", CallSid, CallStatus)
    if CallStatus in ("completed", "failed", "no-answer", "busy", "canceled"):
        await _get_pipeline().handle_call_ended(CallSid)
    return Response(status_code=204)
