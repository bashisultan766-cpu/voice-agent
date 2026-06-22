"""
Spoken-to-typed email normalizer and confirmation state machine.

Converts spoken-word email fragments to standard email addresses:
  "bashi sultan seven six six at gmail dot com" → bashisultan766@gmail.com
  "b a s h i s u l t a n 7 6 6 at gmail dot com" → bashisultan766@gmail.com

Confidence levels:
  high   — looks like a complete, valid email after normalization
  medium — normalized but weak structure (may be missing TLD, etc.)
  low    — partial or unclear; ask caller to spell slowly

Session state:
  pending_email        — normalized candidate awaiting confirmation
  confirmed_email      — caller said "yes that's correct"
  email_rejected       — caller said "no" for the pending candidate

Security rules:
  - PaymentEmailWorker and SendPaymentLink MUST use confirmed_email only.
  - Pending email cannot be used for sending.
  - Rejection clears pending_email entirely.
  - Only confirmed_email is safe for logs (masked) and for payment sends.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

# ── Spoken digit / letter maps ────────────────────────────────────────────────

_DIGIT_WORDS: dict[str, str] = {
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4",
    "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
    # Alternate pronunciations
    "oh": "0", "nought": "0", "ate": "8",
}

# Common spoken abbreviations / filler words to strip
_FILLER_WORDS = {
    "my", "email", "address", "is", "it", "the", "that", "a", "an",
    "i", "said", "type", "send", "to",
}

# Known common domain completions
_DOMAIN_ALIASES: dict[str, str] = {
    "gmail": "gmail.com",
    "yahoo": "yahoo.com",
    "outlook": "outlook.com",
    "hotmail": "hotmail.com",
    "icloud": "icloud.com",
    "aol": "aol.com",
    "proton": "proton.me",
    "protonmail": "protonmail.com",
    "live": "live.com",
    "msn": "msn.com",
    "me": "me.com",
}

# ── Correction / confirmation patterns ────────────────────────────────────────

_CORRECTION_PATS = re.compile(
    r"\b("
    r"no that.?s (wrong|not correct|incorrect)"
    r"|not correct"
    r"|that.?s wrong"
    r"|that.?s not right"
    r"|i said"
    r"|change it to"
    r"|start again"
    r"|no[,.]?\s*try again"
    r"|wrong email"
    r"|incorrect email"
    r")\b",
    re.IGNORECASE,
)

_CONFIRMATION_PATS = re.compile(
    r"^\s*(yes|yeah|yep|correct|right|that.?s (right|correct)|"
    r"sounds? (right|correct|good)|perfect|exactly|go ahead|confirmed?)\b",
    re.IGNORECASE,
)

# ── Core normalizer ────────────────────────────────────────────────────────────

def normalize_spoken_email(text: str) -> Optional[str]:
    """
    Convert a spoken email fragment to a typed email address.

    Returns the normalized email string, or None if the input is not
    recognisably an email (no "@" equivalent found).

    Examples:
      "bashi sultan seven six six at gmail dot com" → "bashisultan766@gmail.com"
      "b a s h i s u l t a n 7 6 6 at gmail dot com" → "bashisultan766@gmail.com"
      "alice dot jones at outlook dot com" → "alice.jones@outlook.com"
    """
    t = text.strip().lower()

    # Strip filler lead-in phrases
    t = re.sub(r"^(my email (address )?is|send (it )?to|email is)\s+", "", t, flags=re.IGNORECASE)

    # Normalise "at" → "@" and "dot" → "."
    # Use word boundaries to avoid replacing "at" inside words like "atlas"
    t = re.sub(r"\bat\b", "@", t)
    t = re.sub(r"\bdot\b", ".", t)

    # Replace spelled-out digits with their numeric equivalents
    for word, digit in _DIGIT_WORDS.items():
        t = re.sub(rf"\b{word}\b", digit, t)

    # Expand single-domain aliases (e.g. "gmail" → "gmail.com")
    # Only applies to the part after "@"
    if "@" in t:
        local, domain = t.split("@", 1)
        domain = domain.strip()
        # Check alias match (strip trailing dots)
        domain_clean = domain.rstrip(".")
        if domain_clean in _DOMAIN_ALIASES and "." not in domain_clean:
            domain = _DOMAIN_ALIASES[domain_clean]
        t = local + "@" + domain
    else:
        # No "@" found — not an email
        return None

    # Remove all spaces (spoken letters are space-separated)
    # But preserve @ and .
    parts = t.split("@", 1)
    local_part = parts[0].replace(" ", "")
    domain_part = parts[1] if len(parts) > 1 else ""

    # In domain part, collapse spaces between domain label segments
    domain_part = re.sub(r"\s+", "", domain_part)

    email = local_part + "@" + domain_part

    # Strip any residual non-email characters (except valid ones)
    email = re.sub(r"[^a-z0-9._%+\-@]", "", email, flags=re.IGNORECASE)

    # Validate minimal shape: something@something.tld
    if not re.match(r"^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$", email, re.IGNORECASE):
        return None

    return email.lower()


def email_confidence(email: Optional[str], raw_text: str) -> str:
    """
    Return 'high', 'medium', or 'low' confidence for a normalized email.

    high   — valid shape, common domain, no obvious issues
    medium — valid shape but unusual domain or short local part
    low    — not a valid email or raw text very short/unclear
    """
    if not email:
        return "low"

    try:
        local, domain = email.split("@", 1)
    except ValueError:
        return "low"

    if len(local) < 2:
        return "low"

    known_domain = any(email.endswith("." + d.split(".")[-1]) for d in _DOMAIN_ALIASES.values())
    common = domain in ("gmail.com", "yahoo.com", "outlook.com", "hotmail.com",
                        "icloud.com", "aol.com", "proton.me", "protonmail.com",
                        "live.com", "me.com", "msn.com")

    # If the raw text contains "@" directly (typed-style), high confidence
    if "@" in raw_text:
        return "high"

    if common and len(local) >= 4:
        return "high"

    if known_domain and len(local) >= 3:
        return "medium"

    return "medium" if len(local) >= 3 else "low"


def is_email_correction(text: str) -> bool:
    """True if the caller is rejecting / correcting the last captured email."""
    return bool(_CORRECTION_PATS.search(text))


def is_email_confirmation(text: str) -> bool:
    """True if the caller is confirming the pending email candidate."""
    return bool(_CONFIRMATION_PATS.match(text.strip()))


# ── Email state dataclass (stored in SessionState) ────────────────────────────

@dataclass
class EmailCaptureState:
    """
    Tracks the email confirmation state machine for one call.

    State transitions:
      (empty) → [caller provides email] → pending_email set
      pending_email + [caller says yes] → confirmed_email set, pending cleared
      pending_email + [caller says no]  → pending cleared, rejected_count++
    """
    pending_email: str = ""
    confirmed_email: str = ""
    confidence: str = "low"        # high | medium | low
    rejected_count: int = 0        # how many times caller rejected

    @property
    def has_confirmed(self) -> bool:
        return bool(self.confirmed_email)

    @property
    def has_pending(self) -> bool:
        return bool(self.pending_email)

    def set_pending(self, email: str, confidence: str) -> None:
        """Offer a new email candidate for confirmation."""
        self.pending_email = email
        self.confidence = confidence

    def confirm(self) -> bool:
        """Caller confirmed pending email. Returns True if there was a pending email."""
        if not self.pending_email:
            return False
        self.confirmed_email = self.pending_email
        self.pending_email = ""
        self.confidence = "high"
        return True

    def reject(self) -> None:
        """Caller rejected pending email. Clear it and increment counter."""
        self.pending_email = ""
        self.confidence = "low"
        self.rejected_count += 1

    def clear_confirmed(self) -> None:
        """Caller explicitly wants to change already-confirmed email."""
        self.confirmed_email = ""
        self.pending_email = ""
        self.confidence = "low"

    def safe_email_for_send(self) -> Optional[str]:
        """Return confirmed email for sending, or None if unconfirmed."""
        return self.confirmed_email or None
