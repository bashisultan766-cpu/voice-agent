"""
Spoken payment/email prompts (v4.28).
"""
from __future__ import annotations

PAYMENT_EMAIL_REQUEST_LINE = (
    "Please tell me your email address. I will email you a secure payment link "
    "for everything in your order. When you open that link, you can enter your "
    "inmate and facility details to complete your order."
)

PAYMENT_EMAIL_REQUEST_SPLIT_HINT = (
    "You can use one email for all books, or separate emails — for example, "
    "send two books to one address and the rest to another."
)


def payment_email_collection_prompt(*, cart_summary: str = "") -> str:
    """Full script when asking the caller for a payment email."""
    parts: list[str] = []
    if cart_summary:
        parts.append(cart_summary.strip())
    parts.append(PAYMENT_EMAIL_REQUEST_LINE)
    parts.append(PAYMENT_EMAIL_REQUEST_SPLIT_HINT)
    return " ".join(parts)
