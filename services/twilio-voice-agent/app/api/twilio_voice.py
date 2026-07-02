"""
POST /voice/twilio/inbound — Twilio inbound call webhook.

Returns TwiML that opens a ConversationRelay WebSocket session.
Twilio handles STT and TTS; we receive/send plain text JSON over the WebSocket.
"""
from __future__ import annotations

import logging
import time
from xml.etree.ElementTree import Element, SubElement, tostring

from fastapi import APIRouter, Depends, Form, Request, Response

from ..config import get_settings, Settings
from ..caller.repository import get_caller_profile
from ..dialogue.greeting import build_resume_twiml_greeting, build_twiml_greeting, greeting_safe_name
from ..security.rate_limit import rate_limit_dependency
from ..security.twilio_signature import validate_twilio_signature
from ..security.ws_token import append_ws_token_to_url
from ..state.session_store import load_call_resume_by_phone

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/voice/twilio", tags=["voice"])


def _mask_phone(number: str) -> str:
    """Return last-4 masked phone for safe logging: ***1234."""
    digits = "".join(c for c in (number or "") if c.isdigit())
    return f"***{digits[-4:]}" if len(digits) >= 4 else "***"


_XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>'


def _render(root: Element) -> str:
    return _XML_HEADER + tostring(root, encoding="unicode")


def _conversation_relay_twiml(
    ws_url: str,
    call_sid: str,
    from_number: str,
    to_number: str,
    agent_id: str = "",
    store_domain: str = "",
    settings: Settings | None = None,
    welcome_greeting: str | None = None,
    include_welcome: bool = True,
) -> str:
    """Build TwiML that instructs Twilio to open a ConversationRelay WebSocket."""
    s = settings or get_settings()

    voice_attrs: dict[str, str] = {
        "url": ws_url,
        "interruptible": "true",
        "language": s.VOICE_LANGUAGE,
        "dtmfDetection": "true",
        "action": f"{s.PUBLIC_BASE_URL.rstrip('/')}/voice/twilio/relay-action",
        "method": "POST",
    }

    if include_welcome and welcome_greeting:
        voice_attrs["welcomeGreeting"] = welcome_greeting
        interruptible = (s.VOICE_WELCOME_GREETING_INTERRUPTIBLE or "any").strip()
        if interruptible:
            voice_attrs["welcomeGreetingInterruptible"] = interruptible

    if s.VOICE_TTS_PROVIDER.lower() == "elevenlabs":
        voice_attrs["ttsProvider"] = "ElevenLabs"
        voice_attrs["voice"] = s.build_conversation_relay_voice()
    else:
        voice_attrs["voice"] = s.build_conversation_relay_voice()

    response = Element("Response")
    connect = SubElement(response, "Connect")
    relay = SubElement(connect, "ConversationRelay", attrib=voice_attrs)

    SubElement(relay, "Parameter", attrib={"name": "callSid", "value": call_sid})
    SubElement(relay, "Parameter", attrib={"name": "from", "value": from_number})
    SubElement(relay, "Parameter", attrib={"name": "to", "value": to_number})
    if agent_id:
        SubElement(relay, "Parameter", attrib={"name": "agentId", "value": agent_id})
    if store_domain:
        SubElement(relay, "Parameter", attrib={"name": "storeDomain", "value": store_domain})
    return _render(response)


async def _is_resume_call(from_number: str, settings: Settings) -> bool:
    """True when caller has a recent resume snapshot within the configured window."""
    if not from_number or from_number == "unknown":
        return False
    try:
        prior_data = await load_call_resume_by_phone(from_number)
        if not prior_data:
            return False
        ended = prior_data.get("call_ended_at", 0.0) or 0.0
        if ended <= 0:
            return False
        age_minutes = (time.time() - ended) / 60.0
        if age_minutes > settings.CALL_RESUME_WINDOW_MINUTES:
            return False
        snapshot = prior_data.get("snapshot", {}) or {}
        return bool(snapshot)
    except Exception:
        logger.debug(
            "Resume check for TwiML greeting failed for %s",
            _mask_phone(from_number),
        )
        return False


async def _resolve_welcome_greeting(from_number: str, settings: Settings) -> tuple[str | None, bool]:
    """
    Resolve TwiML welcome greeting and whether it should be included.

    Returns (greeting_text_or_none, include_welcome).
    """
    if not settings.VOICE_WELCOME_GREETING_ENABLED:
        return None, False

    if await _is_resume_call(from_number, settings):
        return build_resume_twiml_greeting(), True

    if not from_number or from_number == "unknown":
        return build_twiml_greeting(), True

    try:
        profile = await get_caller_profile(from_number)
        if profile and profile.call_count and profile.call_count > 0:
            name = greeting_safe_name((profile.display_name or "").strip())
            return build_twiml_greeting(returning=True, caller_name=name), True
    except Exception:
        logger.debug(
            "Profile lookup for TwiML greeting failed for %s",
            _mask_phone(from_number),
        )
    return build_twiml_greeting(), True


@router.post("/inbound", dependencies=[Depends(rate_limit_dependency("twilio_inbound", limit=120, window_sec=60))])
@router.post("/agent/inbound", dependencies=[Depends(rate_limit_dependency("twilio_inbound", limit=120, window_sec=60))])
async def inbound_call(
    request: Request,
    CallSid: str = Form(...),
    From: str = Form(...),
    To: str = Form(...),
) -> Response:
    """
    Twilio inbound call webhook.

    1. Validate Twilio signature (when VALIDATE_TWILIO_SIGNATURES=true).
    2. Return TwiML with <Connect><ConversationRelay>.
    """
    settings = get_settings()
    await validate_twilio_signature(request, settings)

    logger.info(
        "Inbound call sid=%s from=%s to=%s tts=%s",
        CallSid[:8] if CallSid else "???",
        _mask_phone(From),
        _mask_phone(To),
        settings.VOICE_TTS_PROVIDER,
    )

    agent_id = ""
    store_domain = settings.SHOPIFY_SHOP_DOMAIN
    welcome, include_welcome = await _resolve_welcome_greeting(From, settings)

    ws_base = settings.ws_url
    try:
        ws_url = append_ws_token_to_url(ws_base, call_sid=CallSid, from_number=From)
    except Exception:
        logger.error("ws_token_mint_failed sid=%s", CallSid[:8] if CallSid else "?")
        ws_url = ws_base

    twiml = _conversation_relay_twiml(
        ws_url=ws_url,
        call_sid=CallSid,
        from_number=From,
        to_number=To,
        agent_id=agent_id,
        store_domain=store_domain,
        settings=settings,
        welcome_greeting=welcome,
        include_welcome=include_welcome,
    )
    # Never log voice ID or API keys — TwiML may contain voice attribute only.
    logger.debug("Returning TwiML for %s (voice configured)", CallSid[:8] if CallSid else "?")
    return Response(content=twiml, media_type="application/xml")


@router.post(
    "/relay-action",
    dependencies=[Depends(rate_limit_dependency("twilio_relay_action", limit=120, window_sec=60))],
)
async def relay_action(request: Request) -> Response:
    """
    ConversationRelay action callback — hang up when the agent ends the session.
    """
    settings = get_settings()
    await validate_twilio_signature(request, settings)

    form = await request.form()
    handoff = str(form.get("HandoffData") or form.get("handoffData") or "")
    hangup = "caller_done" in handoff or "goodbye" in handoff.lower()

    if hangup:
        twiml = _XML_HEADER + "<Response><Hangup/></Response>"
    else:
        twiml = _XML_HEADER + "<Response></Response>"

    return Response(content=twiml, media_type="application/xml")
