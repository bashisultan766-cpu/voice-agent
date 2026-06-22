"""
Resend email integration for sending payment links to callers.

Uses the Resend REST API directly via httpx — no SDK required.
RESEND_API_KEY is read from env and never logged.
"""
from __future__ import annotations

import logging
import re
from typing import Optional

import httpx

from ..config import get_settings
from ..email.deliverability import (
    build_payment_email_html,
    build_payment_email_plain,
    build_payment_email_subject,
    validate_payment_email_content,
)

logger = logging.getLogger(__name__)

_RESEND_URL = "https://api.resend.com/emails"
_EMAIL_RE = re.compile(r"^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$")


def _is_valid_email(email: str) -> bool:
    return bool(_EMAIL_RE.match(email.strip()))


def _mask_email(email: str) -> str:
    """Partially mask for safe logging: a***@example.com."""
    if "@" not in email:
        return "***"
    local, domain = email.split("@", 1)
    return local[0] + "***@" + domain


async def send_payment_link_email(
    email: str,
    checkout_url: str,
    product_summary: str,
    caller_name: Optional[str] = None,
    order_or_draft_id: Optional[str] = None,
) -> dict:
    """
    Send a payment link email via Resend.

    Returns a dict with keys: success, message, error (on failure).
    Never raises — callers should always get a result.
    """
    settings = get_settings()

    if not email or not _is_valid_email(email):
        return {"success": False, "error": "Invalid email address."}

    if not checkout_url:
        return {"success": False, "error": "No checkout URL provided."}

    if not settings.RESEND_API_KEY:
        logger.warning("RESEND_API_KEY not set — email not sent")
        return {
            "success": False,
            "error": "Email service not configured.",
            "fallback_message": (
                "I wasn't able to send the email right now, but your payment link is: "
                + checkout_url
            ),
        }

    brand = str(getattr(settings, "RESEND_BRAND_NAME", None) or "SureShot Books")
    from_name = settings.RESEND_FROM_NAME or brand
    from_addr = (
        f"{from_name} <{settings.RESEND_FROM_EMAIL}>"
        if from_name
        else settings.RESEND_FROM_EMAIL
    )

    subject = build_payment_email_subject(brand)
    plain_body = build_payment_email_plain(checkout_url, brand)
    html_body = build_payment_email_html(checkout_url, brand)

    report = validate_payment_email_content(
        subject=subject,
        plain_body=plain_body,
        html_body=html_body,
        from_email=settings.RESEND_FROM_EMAIL,
        reply_to=settings.RESEND_REPLY_TO_EMAIL or settings.SUPPORT_EMAIL,
        checkout_url=checkout_url,
        brand_name=brand,
    )
    if report.issues:
        logger.warning(
            "email_deliverability_issues issues=%s from_domain=%s",
            report.issues,
            report.from_domain,
        )

    payload = {
        "from": from_addr,
        "to": [email.strip()],
        "subject": subject,
        "text": plain_body,
        "html": html_body,
    }

    reply_to = str(getattr(settings, "RESEND_REPLY_TO_EMAIL", "") or getattr(settings, "SUPPORT_EMAIL", "") or "")
    if reply_to:
        payload["reply_to"] = reply_to

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                _RESEND_URL,
                headers={
                    "Authorization": f"Bearer {settings.RESEND_API_KEY}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )

        if resp.status_code in (200, 201):
            logger.info(
                "Payment email sent to %s draft=%s",
                _mask_email(email),
                order_or_draft_id or "n/a",
            )
            return {
                "success": True,
                "message": f"Payment link sent to {email}.",
            }

        # Resend returns error details in the body.
        try:
            err_body = resp.json()
            err_msg = err_body.get("message", resp.text[:120])
        except Exception:
            err_msg = resp.text[:120]

        logger.error("Resend error %s: %s", resp.status_code, err_msg)
        return {"success": False, "error": "Could not deliver the email. Please try again."}

    except httpx.TimeoutException:
        logger.warning("Resend request timed out for %s", _mask_email(email))
        return {"success": False, "error": "Email service timed out. Try again shortly."}
    except Exception as exc:
        logger.exception("Resend unexpected error for %s", _mask_email(email))
        return {"success": False, "error": "Email delivery failed unexpectedly."}
