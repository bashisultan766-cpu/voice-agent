"""
POST /voice/twilio/inbound — Twilio inbound call webhook.

Returns TwiML that opens a ConversationRelay WebSocket session.
Twilio handles STT and TTS; we receive/send plain text JSON over the WebSocket.
"""
from __future__ import annotations

import logging
from xml.etree.ElementTree import Element, SubElement, tostring

from fastapi import APIRouter, Form, Request, Response

from ..config import get_settings, Settings
from ..caller.repository import get_caller_profile
from ..dialogue.greeting import build_twiml_greeting
from ..security.twilio_signature import validate_twilio_signature

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
) -> str:
    """Build TwiML that instructs Twilio to open a ConversationRelay WebSocket."""
    s = settings or get_settings()
    greeting = welcome_greeting or build_twiml_greeting()

    voice_attrs: dict[str, str] = {
        "url": ws_url,
        "welcomeGreeting": greeting,
        "interruptible": "true",
        "language": s.VOICE_LANGUAGE,
        "dtmfDetection": "true",
    }

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


async def _resolve_welcome_greeting(from_number: str) -> str:
    """Personalize TwiML greeting for returning callers when profile exists."""
    if not from_number or from_number == "unknown":
        return build_twiml_greeting()
    try:
        profile = await get_caller_profile(from_number)
        if profile and profile.call_count and profile.call_count > 0:
            return build_twiml_greeting(
                returning=True,
                caller_name=profile.display_name or "",
            )
    except Exception:
        logger.debug("Profile lookup for TwiML greeting failed for %s", _mask_phone(from_number))
    return build_twiml_greeting()


@router.post("/inbound")
async def inbound_call(
    request: Request,
    CallSid: str = Form(...),
    From: str = Form(...),
    To: str = Form(...),
) -> Response:
    """
    Twilio inbound call webhook.

    1. Validate Twilio signature (when VALIDATE_TWILIO_SIGNATURES=true).
    2. Resolve agent/store config by the called number (future: DB lookup).
    3. Return TwiML with <Connect><ConversationRelay>.
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
    welcome = await _resolve_welcome_greeting(From)

    twiml = _conversation_relay_twiml(
        ws_url=settings.ws_url,
        call_sid=CallSid,
        from_number=From,
        to_number=To,
        agent_id=agent_id,
        store_domain=store_domain,
        settings=settings,
        welcome_greeting=welcome,
    )
    # Never log voice ID or API keys — TwiML may contain voice attribute only.
    logger.debug("Returning TwiML for %s (voice configured)", CallSid[:8] if CallSid else "?")
    return Response(content=twiml, media_type="application/xml")
