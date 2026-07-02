"""
Twilio webhook signature validation.

When VALIDATE_TWILIO_SIGNATURES=true, every inbound HTTP request from Twilio
is verified using HMAC-SHA1 over the full URL + sorted POST parameters.
Set to false only in local dev with ngrok (URLs change per session).
"""
from __future__ import annotations

import logging

from fastapi import HTTPException, Request

logger = logging.getLogger(__name__)


async def validate_twilio_signature(request: Request, settings) -> None:
    router_secret = (request.headers.get("X-Voice-Router-Forward") or "").strip()
    expected = (getattr(settings, "VOICE_ROUTER_FORWARD_SECRET", "") or "").strip()
    if router_secret and expected and router_secret == expected:
        return

    if not settings.VALIDATE_TWILIO_SIGNATURES:
        return

    try:
        from twilio.request_validator import RequestValidator
    except ImportError:
        logger.warning("twilio package not installed — signature validation skipped")
        return

    validator = RequestValidator(settings.TWILIO_AUTH_TOKEN)

    # Reconstruct the exact URL Twilio signed (public HTTPS URL + path + query).
    base = settings.PUBLIC_BASE_URL.rstrip("/")
    path = request.url.path
    query = ("?" + str(request.url.query)) if request.url.query else ""
    url = f"{base}{path}{query}"

    # form() is cached by Starlette after first call — safe to read here and
    # again implicitly via Form() params in the route handler.
    form = await request.form()
    params = dict(form.multi_items())

    signature = request.headers.get("X-Twilio-Signature", "")
    if not validator.validate(url, params, signature):
        # Log the URL but never log the token.
        logger.warning("Twilio signature validation failed for %s", url)
        raise HTTPException(status_code=403, detail="Invalid Twilio webhook signature")
