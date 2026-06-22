"""Email deliverability checks and transactional templates (v4.7)."""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlparse

_SPAMMY = re.compile(
    r"\b(urgent|act now|free|guarantee|click immediately|winner|limited time)\b",
    re.IGNORECASE,
)

_FEE_LEAK = re.compile(
    r"\b(processing\s*fee|service\s*fee|internal\s*fee)\b",
    re.IGNORECASE,
)
_URL_SHORTENER = re.compile(
    r"https?://(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|buff\.ly)/",
    re.IGNORECASE,
)


@dataclass
class DeliverabilityReport:
    from_domain: str
    from_email_configured: bool
    reply_to_configured: bool
    subject_safe: bool
    body_safe: bool
    has_plain_text: bool
    has_html: bool
    issues: list[str]

    def ok(self) -> bool:
        return (
            self.from_email_configured
            and self.subject_safe
            and self.body_safe
            and not self.issues
        )


def extract_domain(email: str) -> str:
    if "@" not in email:
        return ""
    return email.split("@", 1)[1].lower()


def build_payment_email_subject(brand_name: str = "SureShot Books") -> str:
    return f"Your {brand_name} payment link"


def build_payment_email_plain(
    checkout_url: str,
    brand_name: str = "SureShot Books",
) -> str:
    return (
        f"Hello,\n\n"
        f"Here is your secure {brand_name} payment link for the books you selected:\n\n"
        f"{checkout_url}\n\n"
        f"If you did not request this, you can ignore this email.\n\n"
        f"Thank you,\n"
        f"{brand_name}"
    )


def build_payment_email_html(
    checkout_url: str,
    brand_name: str = "SureShot Books",
) -> str:
    return f"""<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333">
  <p>Hello,</p>
  <p>Here is your secure {brand_name} payment link for the books you selected:</p>
  <p><a href="{checkout_url}">{checkout_url}</a></p>
  <p>If you did not request this, you can ignore this email.</p>
  <p>Thank you,<br>{brand_name}</p>
</body>
</html>"""


def validate_payment_email_content(
    *,
    subject: str,
    plain_body: str,
    html_body: str = "",
    from_email: str,
    reply_to: str = "",
    checkout_url: str = "",
    brand_name: str = "SureShot Books",
) -> DeliverabilityReport:
    issues: list[str] = []
    from_domain = extract_domain(from_email)
    from_configured = bool(from_email and "@" in from_email and from_domain)

    if not from_configured:
        issues.append("from_email_not_configured")

    if reply_to and extract_domain(reply_to) != from_domain and from_domain:
        issues.append("reply_to_domain_mismatch")

    subject_safe = bool(subject) and not _SPAMMY.search(subject)
    if subject != subject.upper() or subject.isupper():
        pass  # ok if not all caps
    if subject == subject.upper() and len(subject) > 5:
        issues.append("subject_all_caps")
        subject_safe = False

    if _SPAMMY.search(subject):
        subject_safe = False
        issues.append("spammy_subject")

    body_combined = plain_body + " " + html_body
    brand_str = str(brand_name or "SureShot Books")
    body_safe = brand_str in body_combined
    if _SPAMMY.search(body_combined):
        body_safe = False
        issues.append("spammy_body")
    if _FEE_LEAK.search(body_combined) or _FEE_LEAK.search(subject):
        body_safe = False
        issues.append("processing_fee_in_email")
    if _URL_SHORTENER.search(body_combined):
        body_safe = False
        issues.append("url_shortener")
    if checkout_url and body_combined.count(checkout_url) != 1 and checkout_url.count("http") == 1:
        if body_combined.count("http") > 2:
            issues.append("too_many_links")

    has_plain = bool(plain_body.strip())
    has_html = bool(html_body.strip())
    if not has_plain:
        issues.append("missing_plain_text")

    return DeliverabilityReport(
        from_domain=from_domain,
        from_email_configured=from_configured,
        reply_to_configured=bool(reply_to),
        subject_safe=subject_safe,
        body_safe=body_safe,
        has_plain_text=has_plain,
        has_html=has_html,
        issues=issues,
    )


def check_deliverability_config(settings) -> dict:
    """Static config check — no DNS queries, no secrets logged."""
    from_email = getattr(settings, "RESEND_FROM_EMAIL", "") or ""
    reply_to = (
        getattr(settings, "RESEND_REPLY_TO_EMAIL", "")
        or getattr(settings, "SUPPORT_EMAIL", "")
        or ""
    )
    brand = getattr(settings, "RESEND_BRAND_NAME", "SureShot Books") or "SureShot Books"
    domain = extract_domain(from_email)
    return {
        "from_domain": domain or "(not configured)",
        "from_email_configured": bool(from_email and "@" in from_email),
        "reply_to_configured": bool(reply_to),
        "brand_name": brand,
        "dmarc_reminder": (
            "Ensure SPF, DKIM, and DMARC records are configured for your sending domain."
        ),
    }
