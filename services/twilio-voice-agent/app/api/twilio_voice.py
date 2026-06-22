"""
POST /voice/twilio/inbound — Twilio inbound call webhook.

Returns TwiML that opens a ConversationRelay WebSocket session.
Twilio handles STT and TTS; we receive/send plain text JSON over the WebSocket.
"""
from __future__ import annotations

import logging
from xml.etree.ElementTree import Element, SubElement, tostring

from fastapi import APIRouter, Form, Request, Response

from ..config import get_settings
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
) -> str:
    """Build TwiML that instructs Twilio to open a ConversationRelay WebSocket."""
    response = Element("Response")
    connect = SubElement(response, "Connect")
    relay = SubElement(
        connect,
        "ConversationRelay",
        attrib={
            "url": ws_url,
            # Twilio speaks this greeting to the caller before our WS receives 'setup'.
            "welcomeGreeting": (
                "Hello! Thanks for calling. How can I help you today?"
            ),
            # Allow caller to interrupt the agent mid-sentence.
            "interruptible": "true",
            "voice": "Google.en-US-Neural2-J",
            "language": "en-US",
            # dtmfDetection lets us handle keypad input for order numbers etc.
            "dtmfDetection": "true",
        },
    )
    # Custom parameters are forwarded to the WebSocket in the 'setup' message.
    SubElement(relay, "Parameter", attrib={"name": "callSid", "value": call_sid})
    SubElement(relay, "Parameter", attrib={"name": "from", "value": from_number})
    SubElement(relay, "Parameter", attrib={"name": "to", "value": to_number})
    if agent_id:
        SubElement(relay, "Parameter", attrib={"name": "agentId", "value": agent_id})
    if store_domain:
        SubElement(relay, "Parameter", attrib={"name": "storeDomain", "value": store_domain})
    return _render(response)


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
        "Inbound call sid=%s from=%s to=%s",
        CallSid[:8] if CallSid else "???",
        _mask_phone(From),
        _mask_phone(To),
    )

    # TODO: look up agent_id and store_domain from DB using the `To` number.
    # For now, read from env as a single-tenant default.
    agent_id = ""
    store_domain = settings.SHOPIFY_SHOP_DOMAIN

    twiml = _conversation_relay_twiml(
        ws_url=settings.ws_url,
        call_sid=CallSid,
        from_number=From,
        to_number=To,
        agent_id=agent_id,
        store_domain=store_domain,
    )
    logger.debug("Returning TwiML for %s: %s", CallSid, twiml)
    return Response(content=twiml, media_type="application/xml")
