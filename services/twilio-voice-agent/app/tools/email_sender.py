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


def _payment_email_html(
    checkout_url: str,
    product_summary: str,
    caller_name: Optional[str],
    from_name: str,
) -> str:
    greeting = f"Hi {caller_name}," if caller_name else "Hello,"
    return f"""
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
  <h2 style="color:#333">{from_name}</h2>
  <p>{greeting}</p>
  <p>Here is your secure payment link for:</p>
  <p style="background:#f5f5f5;padding:12px;border-radius:4px">
    <strong>{product_summary}</strong>
  </p>
  <p>
    <a href="{checkout_url}"
       style="background:#0070f3;color:#fff;padding:12px 24px;
              text-decoration:none;border-radius:4px;display:inline-block">
      Complete Your Purchase
    </a>
  </p>
  <p style="color:#666;font-size:13px">
    This link expires in 48 hours. If you have questions, just call us back.
  </p>
</body>
</html>
""".strip()


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

    from_addr = (
        f"{settings.RESEND_FROM_NAME} <{settings.RESEND_FROM_EMAIL}>"
        if settings.RESEND_FROM_NAME
        else settings.RESEND_FROM_EMAIL
    )

    payload = {
        "from": from_addr,
        "to": [email.strip()],
        "subject": f"Your Payment Link — {product_summary[:60]}",
        "html": _payment_email_html(
            checkout_url=checkout_url,
            product_summary=product_summary,
            caller_name=caller_name,
            from_name=settings.RESEND_FROM_NAME or "Bookstore Support",
        ),
    }

    # Add reply-to support email if configured.
    if settings.SUPPORT_EMAIL:
        payload["reply_to"] = settings.SUPPORT_EMAIL

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
