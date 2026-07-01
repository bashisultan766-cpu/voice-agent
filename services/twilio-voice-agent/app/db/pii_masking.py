"""
PII and secret masking for Postgres persistence and workflow replay.

Never store raw full card data, API keys, or unmasked email/phone/payment URLs.
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any
from urllib.parse import urlparse

_SECRET_KEY_RE = re.compile(
    r"(api[_-]?key|secret|token|password|authorization|bearer|card|cvv|"
    r"shpat_|sk-|re_[a-zA-Z0-9]{10,})",
    re.IGNORECASE,
)
_EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")
_PHONE_RE = re.compile(r"\+?\d[\d\s\-().]{7,}\d")
_URL_RE = re.compile(r"https?://[^\s\"']+", re.IGNORECASE)

_SENSITIVE_PAYLOAD_KEYS = frozenset({
    "api_key",
    "apikey",
    "authorization",
    "bearer",
    "token",
    "secret",
    "password",
    "card",
    "cvv",
    "email",
    "phone",
    "caller_phone",
    "checkout_url",
    "payment_url",
    "url",
    "confirmed_email",
    "pending_email",
    "raw_email",
})


def mask_phone(number: str) -> str:
    digits = "".join(c for c in (number or "") if c.isdigit())
    if len(digits) >= 4:
        return f"***{digits[-4:]}"
    return "***"


def mask_email(email: str) -> str:
    if not email or "@" not in email:
        return "***"
    local, domain = email.split("@", 1)
    if len(local) <= 1:
        return f"{local}***@{domain}"
    return f"{local[0]}***{local[-1]}@{domain}"


def mask_payment_url(url: str) -> str:
    if not url:
        return ""
    parsed = urlparse(url.strip())
    if not parsed.scheme:
        return "***"
    host = parsed.netloc or ""
    if len(host) > 8:
        host = f"{host[:3]}***{host[-4:]}"
    elif host:
        host = "***"
    return f"{parsed.scheme}://{host}/***"


def hash_phone(phone: str) -> str:
    digits = "".join(c for c in (phone or "") if c.isdigit())
    if not digits:
        return ""
    return hashlib.sha256(digits.encode("utf-8")).hexdigest()


def mask_text(text: str) -> str:
    if not text:
        return ""
    out = _EMAIL_RE.sub(lambda m: mask_email(m.group(0)), text)
    out = _PHONE_RE.sub(lambda m: mask_phone(m.group(0)), out)
    out = _URL_RE.sub(lambda m: mask_payment_url(m.group(0)), out)
    return out


def mask_payload(payload: Any) -> dict[str, Any]:
    """Recursively mask a workflow/tool payload for safe storage."""
    if payload is None:
        return {}
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except (json.JSONDecodeError, TypeError):
            return {"text": mask_text(str(payload))}
    if not isinstance(payload, dict):
        return {"value": mask_text(str(payload))}

    masked: dict[str, Any] = {}
    for key, value in payload.items():
        key_lower = str(key).lower()
        if _SECRET_KEY_RE.search(key_lower) or key_lower in _SENSITIVE_PAYLOAD_KEYS:
            if key_lower in ("email", "caller_phone", "phone", "confirmed_email", "pending_email", "raw_email"):
                if isinstance(value, str):
                    masked[key] = mask_email(value) if "@" in value else mask_phone(value)
                else:
                    masked[key] = "***"
            elif key_lower in ("checkout_url", "payment_url", "url"):
                masked[key] = mask_payment_url(str(value)) if value else ""
            else:
                masked[key] = "***"
            continue
        if isinstance(value, dict):
            masked[key] = mask_payload(value)
        elif isinstance(value, list):
            masked[key] = [
                mask_payload(item) if isinstance(item, dict) else mask_text(str(item))
                for item in value
            ]
        elif isinstance(value, str):
            masked[key] = mask_text(value)
        else:
            masked[key] = value
    return masked


def payload_to_json(payload: Any) -> str:
    masked = mask_payload(payload if isinstance(payload, dict) else {"data": payload})
    return json.dumps(masked, default=str)
