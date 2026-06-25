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
    *,
    company_name: str = "SureShot Books LLC",
    order_lines: list[dict] | None = None,
    subtotal_label: str = "",
    shipping_note: str = "Shipping is calculated separately on the secure payment page.",
) -> str:
    lines_block = _format_lines_plain(order_lines or [])
    subtotal_line = f"\n{subtotal_label}\n" if subtotal_label else "\n"
    return (
        f"Hello,\n\n"
        f"Thank you for ordering from {company_name}.\n\n"
        f"Your order:\n{lines_block}{subtotal_line}"
        f"{shipping_note}\n\n"
        f"Complete your secure payment here:\n{checkout_url}\n\n"
        f"On the payment page you can enter inmate and facility details.\n\n"
        f"Thank you,\n{brand_name}"
    )


def _format_lines_plain(order_lines: list[dict]) -> str:
    if not order_lines:
        return "- Your selected books\n"
    rows = []
    for line in order_lines:
        qty = int(line.get("quantity") or 1)
        title = line.get("title") or "Book"
        price = line.get("price") or ""
        row = f"- {qty}x {title}"
        if price:
            row += f" — {price} each"
        rows.append(row)
    return "\n".join(rows) + "\n"


def _money_subtotal(order_lines: list[dict]) -> str:
    from ..payment.drop_shipping_fee import order_subtotal_with_fee

    total = order_subtotal_with_fee(order_lines)
    return f"${total:.2f}" if total > 0 else ""


def build_payment_email_html(
    checkout_url: str,
    brand_name: str = "SureShot Books",
    *,
    company_name: str = "SureShot Books LLC",
    order_lines: list[dict] | None = None,
    subtotal_label: str = "",
    shipping_note: str = "Shipping is calculated separately at checkout.",
) -> str:
    rows_html = ""
    for line in order_lines or []:
        qty = int(line.get("quantity") or 1)
        title = line.get("title") or "Book"
        price = line.get("price") or ""
        unit = f"${price}" if price and not str(price).startswith("$") else (price or "")
        line_total = ""
        try:
            line_total_val = float(str(price).replace("$", "").strip()) * qty
            line_total = f"${line_total_val:.2f}"
        except (ValueError, TypeError):
            line_total = ""
        rows_html += (
            f"<tr>"
            f"<td style='padding:8px;border-bottom:1px solid #eee'>{qty}</td>"
            f"<td style='padding:8px;border-bottom:1px solid #eee'>{title}</td>"
            f"<td style='padding:8px;border-bottom:1px solid #eee'>{unit}</td>"
            f"<td style='padding:8px;border-bottom:1px solid #eee;text-align:right'>"
            f"{line_total}</td></tr>"
        )
    if not rows_html:
        rows_html = (
            "<tr><td colspan='4' style='padding:8px'>Your selected books</td></tr>"
        )
    subtotal_html = (
        f"<p style='margin:16px 0 8px;font-weight:bold'>Subtotal (before shipping): "
        f"{subtotal_label}</p>"
        if subtotal_label
        else ""
    )
    return f"""<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#222;background:#f9f9f9">
  <div style="background:#fff;border-radius:8px;padding:24px;border:1px solid #e5e5e5">
    <h1 style="margin:0 0 4px;font-size:22px;color:#1a3a5c">{company_name}</h1>
    <p style="margin:0 0 20px;color:#666">Secure payment for your SureShot Books order</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:12px">
      <thead>
        <tr style="background:#f0f4f8">
          <th style="padding:8px;text-align:left">Qty</th>
          <th style="padding:8px;text-align:left">Item</th>
          <th style="padding:8px;text-align:left">Price</th>
          <th style="padding:8px;text-align:right">Line total</th>
        </tr>
      </thead>
      <tbody>{rows_html}</tbody>
    </table>
    {subtotal_html}
    <p style="margin:8px 0 16px;color:#555">{shipping_note}</p>
    <p style="text-align:center;margin:28px 0">
      <a href="{checkout_url}" style="background:#1a6b3c;color:#fff;text-decoration:none;
        padding:14px 28px;border-radius:6px;font-size:16px;font-weight:bold;
        display:inline-block">Complete Secure Payment</a>
    </p>
    <p style="font-size:12px;color:#888;text-align:center">
      You will enter inmate and facility details on the payment page.
    </p>
    <p style="margin-top:24px">Thank you,<br><strong>{brand_name}</strong></p>
  </div>
</body>
</html>"""

def build_payment_email_bodies(
    checkout_url: str,
    *,
    brand_name: str = "SureShot Books",
    company_name: str = "SureShot Books LLC",
    order_lines: list[dict] | None = None,
) -> tuple[str, str, str]:
    """Return (subject, plain, html) with line items and subtotal."""
    lines = order_lines or []
    subtotal = _money_subtotal(lines)
    subtotal_label = subtotal or "see payment page"
    shipping_note = (
        "Shipping is calculated separately on the secure payment page — "
        "it is not included in the subtotal above."
    )
    subject = build_payment_email_subject(brand_name)
    plain = build_payment_email_plain(
        checkout_url,
        brand_name,
        company_name=company_name,
        order_lines=lines,
        subtotal_label=f"Subtotal before shipping: {subtotal_label}",
        shipping_note=shipping_note,
    )
    html = build_payment_email_html(
        checkout_url,
        brand_name,
        company_name=company_name,
        order_lines=lines,
        subtotal_label=subtotal_label,
        shipping_note=shipping_note,
    )
    return subject, plain, html


def validate_payment_email_content(    *,
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
