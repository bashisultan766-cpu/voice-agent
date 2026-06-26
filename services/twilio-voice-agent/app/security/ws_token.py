"""
Signed short-lived tokens for ConversationRelay WebSocket authentication.

The inbound Twilio webhook mints a token after signature validation; the
WebSocket endpoint rejects connections without a valid token.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import time
from typing import Any

from ..config import get_settings

logger = logging.getLogger(__name__)

_DEFAULT_TTL_SEC = 300


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    pad = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + pad)


def mint_ws_token(
    *,
    call_sid: str,
    from_number: str,
    ttl_sec: int = _DEFAULT_TTL_SEC,
) -> str:
    """Return ``payload_b64.signature`` HMAC token."""
    settings = get_settings()
    secret = settings.ws_token_secret
    if not secret:
        raise RuntimeError("WS token secret not configured")

    payload: dict[str, Any] = {
        "callSid": call_sid,
        "from": from_number,
        "exp": int(time.time()) + max(30, ttl_sec),
    }
    payload_b64 = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode())
    sig = hmac.new(secret.encode(), payload_b64.encode(), hashlib.sha256).digest()
    return f"{payload_b64}.{_b64url_encode(sig)}"


def validate_ws_token(token: str) -> dict[str, Any] | None:
    """Return decoded payload when valid; otherwise None."""
    if not token or "." not in token:
        return None

    settings = get_settings()
    secret = settings.ws_token_secret
    if not secret:
        logger.warning("ws_token_rejected reason=no_secret_configured")
        return None

    payload_b64, sig_b64 = token.split(".", 1)
    expected = hmac.new(secret.encode(), payload_b64.encode(), hashlib.sha256).digest()
    try:
        provided = _b64url_decode(sig_b64)
    except Exception:
        logger.warning("ws_token_rejected reason=bad_signature_encoding")
        return None

    if not hmac.compare_digest(expected, provided):
        logger.warning("ws_token_rejected reason=invalid_signature")
        return None

    try:
        payload = json.loads(_b64url_decode(payload_b64))
    except Exception:
        logger.warning("ws_token_rejected reason=bad_payload")
        return None

    exp = int(payload.get("exp") or 0)
    if exp <= time.time():
        logger.warning("ws_token_rejected reason=expired call_sid=%s", str(payload.get("callSid", ""))[:8])
        return None

    if not payload.get("callSid"):
        logger.warning("ws_token_rejected reason=missing_call_sid")
        return None

    return payload


def append_ws_token_to_url(ws_url: str, *, call_sid: str, from_number: str) -> str:
    """Append ``?token=`` or ``&token=`` to the WebSocket URL."""
    token = mint_ws_token(call_sid=call_sid, from_number=from_number)
    sep = "&" if "?" in ws_url else "?"
    return f"{ws_url}{sep}token={token}"
