"""Email capture orchestrator — spoken email normalization and verification (v4.14.9)."""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any

from ..payment.safety import _mask_email

logger = logging.getLogger(__name__)

_KNOWN_DOMAINS = {
    "gmail": "gmail.com",
    "outlook": "outlook.com",
    "hotmail": "hotmail.com",
    "yahoo": "yahoo.com",
    "icloud": "icloud.com",
    "aol": "aol.com",
}

_DIGIT_WORDS = {
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4",
    "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
}

_SPOKEN_AT_PAT = re.compile(
    r"\b([a-z0-9._%+\-\s]+?)\s+at\s+([a-z0-9.\-\s]+?)\s+dot\s+([a-z0-9.\-\s]+)\b",
    re.I,
)
_EMAIL_SYNTAX_PAT = re.compile(
    r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$",
)


@dataclass
class EmailValidationResult:
    email: str | None = None
    normalized: str | None = None
    syntax_valid: bool = False
    domain_present: bool = False
    customer_confirmed: bool = False
    deliverability_checked: bool = False
    confidence: str = "low"  # low | medium | high
    spellback: str = ""
    uncertain: bool = False
    suggested_alternatives: list[str] = field(default_factory=list)
    rejection_reason: str = ""


def _short_sid(sid: str) -> str:
    return sid[:6] if sid else "?"


def _spoken_words_to_chars(text: str) -> str:
    out = text.lower()
    for word, digit in _DIGIT_WORDS.items():
        out = re.sub(rf"\b{word}\b", digit, out)
    out = out.replace(" dash ", "-").replace(" underscore ", "_")
    out = out.replace(" dot ", ".")
    return out


def _collapse_spoken_local(local: str) -> str:
    """Normalize spoken local part: spaces may become dots for gmail-style addresses."""
    cleaned = _spoken_words_to_chars(local.strip())
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    # "bashi sultan 766" -> bashi.sultan766 (common gmail pattern)
    if " " in cleaned and "." not in cleaned:
        parts = cleaned.split()
        if len(parts) >= 2 and parts[-1].isdigit():
            return ".".join(parts[:-1]) + parts[-1]
        return ".".join(parts)
    return cleaned.replace(" ", "")


def _collapse_spoken_domain(domain: str, tld: str) -> str:
    domain_clean = _spoken_words_to_chars(domain.strip())
    domain_clean = re.sub(r"\s+", "", domain_clean.replace(" dot ", "."))
    tld_clean = _spoken_words_to_chars(tld.strip()).replace(" ", "")
    full_domain = f"{domain_clean}.{tld_clean}" if tld_clean else domain_clean

    lower = full_domain.lower()
    for key, canonical in _KNOWN_DOMAINS.items():
        if lower == key or lower.startswith(key + "."):
            return canonical
    return full_domain.lower()


def normalize_spoken_email(text: str) -> EmailValidationResult:
    """Parse and normalize spoken email from caller text."""
    raw = (text or "").lower()
    logger.info("email_capture_started sid=? raw_len=%d", len(text or ""))

    # Already typed email
    typed = re.search(r"\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b", text or "")
    if typed:
        email = typed.group(1).lower()
        masked = _mask_email(email)
        logger.info("email_normalized sid=? masked_email=%s", masked)
        return EmailValidationResult(
            email=email,
            normalized=email,
            syntax_valid=bool(_EMAIL_SYNTAX_PAT.match(email)),
            domain_present="@" in email and "." in email.split("@", 1)[1],
            confidence="high",
            spellback=prepare_email_spellback(email),
        )

    match = _SPOKEN_AT_PAT.search(raw)
    if not match:
        return EmailValidationResult(
            rejection_reason="no_email_detected",
            spellback="I didn't catch a complete email address. Could you say it again?",
        )

    local = _collapse_spoken_local(match.group(1))
    domain = _collapse_spoken_domain(match.group(2), match.group(3))
    email = f"{local}@{domain}"
    syntax_ok = bool(_EMAIL_SYNTAX_PAT.match(email))
    masked = _mask_email(email) if syntax_ok else "***@***"
    logger.info("email_normalized sid=? masked_email=%s", masked)

    uncertain = " " in match.group(1) and local.count(".") == 0
    alternatives: list[str] = []
    if uncertain:
        alt_local = match.group(1).strip().replace(" ", ".")
        for word, digit in _DIGIT_WORDS.items():
            alt_local = re.sub(rf"\b{word}\b", digit, alt_local.lower())
        alternatives.append(f"{alt_local}@{domain}")

    result = EmailValidationResult(
        email=email if syntax_ok else None,
        normalized=email,
        syntax_valid=syntax_ok,
        domain_present="@" in email and "." in domain,
        confidence="high" if syntax_ok and not uncertain else "medium",
        uncertain=uncertain,
        suggested_alternatives=alternatives,
        spellback=prepare_email_spellback(email),
    )
    if uncertain and alternatives:
        alt = alternatives[0].replace("@", " at ").replace(".", " dot ")
        result.spellback = (
            f"Did you mean {alt}? Please say yes or repeat the email."
        )
    logger.info("email_spellback_prepared sid=? masked_email=%s", masked)
    return result


def prepare_email_spellback(email: str, *, letter_by_letter: bool = False) -> str:
    """Build customer-facing spellback prompt."""
    if not email or "@" not in email:
        return "I need a valid email address. Could you say it again?"
    local, domain = email.split("@", 1)
    heard = f"{local.replace('.', ' dot ')} at {domain.replace('.', ' dot ')}"
    if letter_by_letter:
        spelled = ", ".join(ch for ch in heard if ch.strip())
        return f"I heard {spelled}. Is that correct?"
    return f"I heard {heard}. Is that correct?"


def validate_email_syntax(email: str) -> bool:
    return bool(_EMAIL_SYNTAX_PAT.match((email or "").strip()))


def confirm_email(
    email: str,
    *,
    sid: str = "",
    confirmed: bool = True,
) -> EmailValidationResult:
    """Mark email as customer-confirmed after yes/no."""
    if not validate_email_syntax(email):
        logger.info("email_rejected sid=%s reason=invalid_syntax", _short_sid(sid))
        return EmailValidationResult(
            rejection_reason="invalid_syntax",
            spellback="That email doesn't look valid. Could you say it again?",
        )
    if not confirmed:
        logger.info("email_rejected sid=%s reason=customer_rejected", _short_sid(sid))
        return EmailValidationResult(
            email=email,
            normalized=email.lower(),
            syntax_valid=True,
            domain_present=True,
            rejection_reason="customer_rejected",
            spellback="Okay. What email should I use instead?",
        )
    masked = _mask_email(email)
    logger.info("email_confirmed sid=%s masked_email=%s", _short_sid(sid), masked)
    return EmailValidationResult(
        email=email.lower(),
        normalized=email.lower(),
        syntax_valid=True,
        domain_present=True,
        customer_confirmed=True,
        confidence="high",
        spellback=f"Thank you. I'll send the payment link to {masked}.",
    )


def email_blocks_payment(result: EmailValidationResult) -> str | None:
    """Return blocking message if email is not ready for payment."""
    if result.customer_confirmed and result.syntax_valid:
        return None
    if not result.syntax_valid:
        return "That email doesn't look valid. Could you say it again?"
    return "I need to confirm the email before I send the payment link."


def handle_email_capture_turn(
    text: str,
    *,
    sid: str = "",
    pending_email: str = "",
    awaiting_confirmation: bool = False,
) -> dict[str, Any]:
    """Process one email capture turn."""
    from .tool_entity_extractor import is_strong_add_commitment, is_rejection_phrase

    if awaiting_confirmation and pending_email:
        if is_strong_add_commitment(text):
            result = confirm_email(pending_email, sid=sid, confirmed=True)
            return {
                "action": "email_confirmed",
                "email": result.email,
                "message": result.spellback,
                "validation": result,
            }
        if is_rejection_phrase(text):
            result = confirm_email(pending_email, sid=sid, confirmed=False)
            return {
                "action": "email_rejected",
                "email": None,
                "message": result.spellback,
                "validation": result,
            }

    parsed = normalize_spoken_email(text)
    if not parsed.syntax_valid:
        block = email_blocks_payment(parsed)
        return {
            "action": "email_invalid",
            "email": None,
            "message": block or parsed.spellback,
            "validation": parsed,
        }

    return {
        "action": "email_spellback_required",
        "email": parsed.email,
        "message": parsed.spellback,
        "validation": parsed,
    }
