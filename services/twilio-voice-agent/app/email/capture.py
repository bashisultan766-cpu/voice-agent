"""
Spoken-to-typed email normalizer and confirmation state machine.

Converts spoken-word email fragments to standard email addresses:
  "bashi sultan seven six six at gmail dot com"   → bashisultan766@gmail.com
  "bashi sultan 7 6 6 activate g mail dot com"    → bashisultan766@gmail.com
  "b a s h i s u l t a n at the rate gmail dot c o m" → bashisultan766@gmail.com

ASR variants handled:
  "activate"    → "@"   (Twilio STT artifact for the @ symbol)
  "at the rate" → "@"   (common spoken form)
  "at rate"     → "@"
  "add"         → "@"   (misheard "at"; only before known domains)
  "period"      → "."   (alternate for "dot")
  "gamil", "g a m i l", "g mail" → "gmail"
  "dot c o m", "c o m" after "." → ".com"  (space-separated TLD letters)
  Leading single-letter artifact  → lowered confidence (asks confirmation)

Confidence levels:
  high   — valid shape, common domain, typed "@" present, or no artifacts
  medium — valid shape but unusual domain or short local
  low    — partial/unclear, prefix artifact detected, or raw text very short

Multi-turn fragment support:
  is_domain_suffix_only(text)        — True if text is only "dot com" / ".com" / etc.
  assemble_email_from_fragments(lst) — join and normalize multi-turn fragments

Session state:
  pending_email        — normalized candidate awaiting confirmation
  confirmed_email      — caller said "yes" — safe for payment sends
  email_rejected       — caller said "no" — clear and increment counter

Security rules:
  - PaymentEmailWorker and send_payment_link_email MUST use confirmed_email only.
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
    "g mail": "gmail.com",
    "ymail": "yahoo.com",
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
    "rediffmail": "rediffmail.com",
    "rediff": "rediffmail.com",
    "mail": "mail.com",
    "zoho": "zoho.com",
    "fastmail": "fastmail.com",
    "gmx": "gmx.com",
    "web": "web.de",
    "yandex": "yandex.com",
    "qq": "qq.com",
    "163": "163.com",
    "126": "126.com",
    "googlemail": "gmail.com",
    "rocketmail": "yahoo.com",
    "att": "att.net",
    "comcast": "comcast.net",
    "verizon": "verizon.net",
    "bellsouth": "bellsouth.net",
    "cox": "cox.net",
    "charter": "charter.net",
    "sbcglobal": "sbcglobal.net",
}

# Domain misspellings produced by ASR (applied after space-removal)
_DOMAIN_FIXES: dict[str, str] = {
    "gamil": "gmail",
    "gmaill": "gmail",
    "gmale": "gmail",
    "gmai": "gmail",
    "yahooo": "yahoo",
    "yaho": "yahoo",
    "outlok": "outlook",
    "outloook": "outlook",
    "hotmial": "hotmail",
    "hotmil": "hotmail",
    "iclod": "icloud",
    "iclould": "icloud",
    "periodgmail": "gmail",
    "therategmail": "gmail",
    "thegmail": "gmail",
    "atgmail": "gmail",
    "rate gmail": "gmail",
}

# ── Correction / confirmation patterns ────────────────────────────────────────

_EMAIL_SUPPLY_PAT = re.compile(
    r"\b(?:my\s+)?(?:correct\s+)?email(?:\s+address)?\s+is\b",
    re.IGNORECASE,
)


def is_supplying_email_address(text: str) -> bool:
    """True when caller is dictating a new email, not confirming the pending one."""
    return bool(_EMAIL_SUPPLY_PAT.search((text or "").strip()))


def email_capture_turn_active(session: object) -> bool:
    """True when payment or support handoff is collecting or confirming an email."""
    try:
        from ..payment.email_state import email_capture_mode_active

        if email_capture_mode_active(session):  # type: ignore[arg-type]
            return True
    except Exception:  # noqa: BLE001
        pass
    if getattr(session, "awaiting_payment_email", False):
        return True
    if getattr(session, "awaiting_payment_email_confirmation", False):
        return True
    pfs = getattr(session, "payment_flow_status", "idle") or "idle"
    if pfs in ("awaiting_email", "awaiting_email_confirmation", "awaiting_send_confirmation"):
        return True
    if getattr(session, "awaiting_not_found_escalation_email", False):
        pending = getattr(session, "pending_not_found_escalation", None) or {}
        if isinstance(pending, dict) and (
            pending.get("awaiting_email_confirmation")
            or not pending.get("email_confirmed")
        ):
            return True
    return False


_CORRECTION_PATS = re.compile(
    r"\b("
    r"no that.?s (wrong|not correct|incorrect)"
    r"|not correct"
    r"|it.?s not correct"
    r"|that.?s not correct"
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
    r"^\s*(yes|yeah|yep|yup|sure|ok|okay|haan|han|ha|ji|theek|thik|sahi|bilkul|absolutely)\b"
    r"|^\s*(right|correct)\s*[.!]?\s*$"
    r"|^\s*(that\s*'?s\s+)?(right|correct)(\s+email)?\s*[.!]?\s*$"
    r"|^\s*that\s*'?s\s+(the\s+)?(right|correct)\s+email"
    r"|\b(theek hai|thik hai|sahi hai|that is correct|that's correct|that's true|that is true|you got it|exactly right)\b"
    r"|\b(that'?s?\s+)?fine\b|\bit'?s?\s+fine\b|\b(that\s+is|that's)\s+fine\b"
    r"|\b(all good|good to go|that works|works for me|sounds?\s+fine)\b"
    r"|sounds?\s+(right|correct|good)"
    r"|^\s*(perfect|exactly|go ahead|confirmed?)\b",
    re.IGNORECASE,
)

_REPEAT_EMAIL_PAT = re.compile(
    r"\b(repeat|spell|read\s+back|say\s+again|what\s+was|can\s+you)\b.*\b(email|address)\b"
    r"|\b(email|address)\b.*\b(repeat|again|spell|letter\s+by\s+letter)\b",
    re.IGNORECASE,
)
_SPELL_EMAIL_PAT = re.compile(
    r"\b(spell|letter\s+by\s+letter|read\s+back)\b.*\b(email|address)\b"
    r"|\b(email|address)\b.*\b(spell|letter\s+by\s+letter)\b",
    re.IGNORECASE,
)

# ── Domain-suffix-only fragment pattern ───────────────────────────────────────

_SUFFIX_PAT = re.compile(
    r"^\.?(com|net|org|edu|gov|io|me|co\.?uk)$",
    re.IGNORECASE,
)


_KNOWN_PROVIDER_DOMAINS = frozenset(_DOMAIN_ALIASES.values()) | frozenset({
    "gmail.com", "yahoo.com", "outlook.com", "hotmail.com",
    "icloud.com", "aol.com", "proton.me", "protonmail.com",
    "live.com", "me.com", "msn.com", "mail.com", "zoho.com",
    "gmx.com", "yandex.com", "rediffmail.com", "att.net",
    "comcast.net", "verizon.net", "bellsouth.net", "cox.net",
})


# ── Core normalizer ────────────────────────────────────────────────────────────

def normalize_spoken_email(text: str) -> Optional[str]:
    """
    Convert a spoken email fragment to a typed email address.

    Returns the normalized email string, or None if the input is not
    recognisably an email (no "@" equivalent found).

    Examples:
      "bashi sultan seven six six at gmail dot com"    → "bashisultan766@gmail.com"
      "bashi sultan 7 6 6 activate g mail dot com"     → "bashisultan766@gmail.com"
      "b a s h i at the rate gmail dot c o m"          → "bashi@gmail.com"
      "alice dot jones at outlook dot com"              → "alice.jones@outlook.com"
      "P b a s h i at gmail dot com"                   → "pbashi@gmail.com" (low conf)
    """
    t = text.strip().lower()

    # Strip filler lead-in phrases
    t = re.sub(
        r"^(?:(?:the\s+)?(?:my\s+)?(?:correct\s+)?email(?:\s+address)?\s+is|send\s+(?:it\s+)?to|"
        r"it.?s)\s+",
        "",
        t,
        flags=re.IGNORECASE,
    )

    # ── AT-word normalization (before the generic "at" → "@" substitution) ────
    # Multi-word forms first (most specific)
    t = re.sub(r"\bat the rate\b", "at", t, flags=re.IGNORECASE)
    t = re.sub(r"\bat rate\b",     "at", t, flags=re.IGNORECASE)
    # "activate" → "at" — common Twilio STT artifact for the "@" symbol
    t = re.sub(r"\bactivate\b", "at", t, flags=re.IGNORECASE)
    # "add" → "at" only when immediately before a known domain name
    t = re.sub(
        r"\badd\b(?=\s+(?:gmail|yahoo|outlook|hotmail|icloud|aol|proton|live|msn|me|"
        r"googlemail|rocketmail|mail|zoho|gmx|yandex|rediff|att|comcast|verizon)\b)",
        "at", t, flags=re.IGNORECASE,
    )

    # "period" → "dot" (alternative TLD-separator spoken form)
    t = re.sub(r"\bperiod\b", "dot", t, flags=re.IGNORECASE)
    # Spoken punctuation in email addresses
    t = re.sub(r"\bhyphen\b", "-", t, flags=re.IGNORECASE)
    t = re.sub(r"\bdash\b", "-", t, flags=re.IGNORECASE)
    t = re.sub(r"\bunderscore\b", "_", t, flags=re.IGNORECASE)
    t = re.sub(r"\bplus\b", "+", t, flags=re.IGNORECASE)

    # Normalise "dot" → "." and "at" → "@"
    t = re.sub(r"\bdot\b", ".", t)
    t = re.sub(r"\bat\b",  "@", t)

    # Replace spelled-out digits
    for word, digit in _DIGIT_WORDS.items():
        t = re.sub(rf"\b{word}\b", digit, t)

    # Require "@" to proceed
    if "@" not in t:
        return None

    local_raw, domain_raw = t.split("@", 1)

    # Remove spaces and spoken punctuation from local part
    local_part = re.sub(r"[,\s]+", "", local_raw)
    domain_part = re.sub(r"\s+", "", domain_raw)

    local_part, _activate_stripped = _clean_activate_in_local(local_part, text)

    # Fix domain misspellings produced by ASR (applied after space removal)
    for wrong, right in _DOMAIN_FIXES.items():
        if domain_part == wrong or domain_part.startswith(wrong + "."):
            domain_part = domain_part.replace(wrong, right, 1)
            break

    # Expand domain aliases (e.g. "gmail" → "gmail.com")
    domain_part = domain_part.rstrip(".")
    domain_clean = domain_part.rstrip(".")
    if domain_clean in _DOMAIN_ALIASES and "." not in domain_clean:
        domain_part = _DOMAIN_ALIASES[domain_clean]
    elif domain_part.startswith("googlemail."):
        domain_part = "gmail." + domain_part[len("googlemail."):]

    email = local_part + "@" + domain_part.rstrip(".")

    # Strip residual non-email characters (commas, quotes, spaces escaped earlier)
    email = re.sub(r"[^a-z0-9._%+\-@]", "", email, flags=re.IGNORECASE)
    email = email.rstrip(".")

    # Validate minimal shape: something@something.tld
    if not re.match(r"^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$", email, re.IGNORECASE):
        return None

    return email.lower()


def _clean_activate_in_local(local_part: str, raw_text: str) -> tuple[str, bool]:
    """
    Strip ASR 'activate' glued into the local part (Twilio @ artifact).

    Returns (cleaned_local, was_stripped).
    """
    original = local_part
    lower = local_part.lower()

    # Glued before domain name without @: 766activategmail
    local_part = re.sub(
        r"activate(?=(?:gmail|yahoo|outlook|hotmail|icloud|aol|proton|live|msn|me)\b)",
        "",
        local_part,
        flags=re.IGNORECASE,
    )

    # Trailing activate glued to digits/letters: bashisultan766activate
    if lower.endswith("activate") and len(local_part) > len("activate"):
        local_part = local_part[: -len("activate")]

    # Dot-separated artifact: bashisultan.766activate
    local_part = re.sub(r"\.activate$", "", local_part, flags=re.IGNORECASE)

    return local_part, local_part != original


# ── Prefix-artifact detection ─────────────────────────────────────────────────

def _has_prefix_artifact(raw_text: str) -> bool:
    """
    Heuristic: detect accidental leading UPPERCASE single letter before a spelled-out email.

    Real Twilio STT pattern: "P b a s h i s u l t a n..." — STT capitalises the stray
    leading letter but the rest of the spelling is lowercase single chars.

    Returns False for:
      "b a s h i s u l t a n at gmail dot com"   — all lowercase, no artifact
      "B a s h i s u l t a n at gmail dot com"   — 'B' is legitimately the first letter
      "bashisultan766@gmail.com"                  — typed email
    Returns True for:
      "P b a s h i s u l t a n at gmail dot com" — 'P' uppercase, rest lowercase singles
    """
    # Work on the raw (pre-lowercase) text to detect uppercase capitalisation artifact
    t = raw_text.strip()
    t = re.sub(r"^(my email (?:address )?is|send (?:it )?to)\s+", "", t, flags=re.IGNORECASE)
    tokens = t.split()
    if len(tokens) < 5:
        return False
    # Find index of AT marker (case-insensitive)
    at_idx = next(
        (i for i, tk in enumerate(tokens) if tk.lower() in {"at", "activate", "@"}),
        len(tokens),
    )
    prefix = tokens[:at_idx]
    if len(prefix) < 4:
        return False
    # Specific pattern: first token is an UPPERCASE single letter
    # and the following 3+ tokens are single lowercase letters/digits
    first_upper = len(prefix[0]) == 1 and prefix[0].isupper()
    next_lower_singles = sum(
        1 for tk in prefix[1:5] if len(tk) == 1 and (tk.islower() or tk.isdigit())
    )
    return first_upper and next_lower_singles >= 3


# ── Domain suffix fragment detection ──────────────────────────────────────────

def is_domain_suffix_only(text: str) -> bool:
    """
    True if text contains only a TLD completion: 'dot com', '.com', 'dot net', etc.

    Used for multi-turn email fragment assembly:
      turn 1: "bashisultan766@gmail"
      turn 2: "dot com"  ← is_domain_suffix_only returns True
    """
    t = text.strip().lower()
    # Strip trivial filler
    t = re.sub(r"^(it.?s|that.?s|the|and)?\s*", "", t)
    t = re.sub(r"\bdot\b",    ".", t)
    t = re.sub(r"\bperiod\b", ".", t)
    t = re.sub(r"\s+", "", t)
    return bool(_SUFFIX_PAT.match(t))


# ── Multi-turn fragment assembler ─────────────────────────────────────────────

def assemble_email_from_fragments(fragments: list[str]) -> Optional[str]:
    """
    Try to assemble a complete email from multiple spoken turns.

    Example:
      fragments = ["bashisultan766@gmail", "dot com"]
      → "bashisultan766@gmail.com"
    """
    if not fragments:
        return None
    combined = " ".join(fragments)
    return normalize_spoken_email(combined)


_EMAIL_CLAUSE_HINT = re.compile(
    r"\b(?:at|@|activate|gmail|yahoo|outlook|hotmail|icloud)\b",
    re.IGNORECASE,
)
_EMAIL_ADDRESS_IS = re.compile(
    r"\b(?:my\s+)?email(?:\s+address)?\s+is\b",
    re.IGNORECASE,
)


def extract_best_email_phrase(text: str) -> str:
    """
    Pull the most likely email-bearing clause from a polluted STT merge.

    Turn assembler can merge hello/keepalive fragments into an email buffer;
    this prefers the last sentence that looks like an email dictation.
    """
    raw = (text or "").strip()
    if not raw:
        return ""

    clauses = [c.strip() for c in re.split(r"[.?!]+", raw) if c.strip()]
    if not clauses:
        clauses = [raw]

    for clause in reversed(clauses):
        if not _EMAIL_CLAUSE_HINT.search(clause):
            continue
        if normalize_spoken_email(clause):
            return clause

    for clause in reversed(clauses):
        if _EMAIL_ADDRESS_IS.search(clause):
            return clause

    if _EMAIL_CLAUSE_HINT.search(raw):
        return raw
    return raw


# ── Confidence scorer ─────────────────────────────────────────────────────────

def _has_activate_local_artifact(email: Optional[str], raw_text: str) -> bool:
    """True when 'activate' remains inside the normalized local part."""
    if not email or "@" not in email:
        return False
    local = email.split("@", 1)[0].lower()
    return "activate" in local


def email_confidence(email: Optional[str], raw_text: str) -> str:
    """
    Return 'high', 'medium', or 'low' confidence for a normalized email.

    high   — valid shape, common domain, no obvious issues
    medium — valid shape but unusual domain or short local part
    low    — not valid, raw text very short/unclear, or prefix artifact detected
    """
    if not email:
        return "low"

    if _has_activate_local_artifact(email, raw_text):
        return "low"

    # If raw text has an accidental leading single-letter prefix → low confidence
    if _has_prefix_artifact(raw_text):
        return "low"

    try:
        local, domain = email.split("@", 1)
    except ValueError:
        return "low"

    if len(local) < 2:
        return "low"

    common = domain in _KNOWN_PROVIDER_DOMAINS

    # If the raw text contains "@" directly (typed-style)
    if "@" in raw_text:
        if re.search(r"activate", raw_text, re.IGNORECASE) and "activate" not in local:
            return "medium"
        return "high"

    if common and len(local) >= 4:
        return "high"

    known_domain = any(
        email.endswith("." + d.split(".")[-1]) for d in _DOMAIN_ALIASES.values()
    )
    if known_domain and len(local) >= 3:
        return "medium"

    return "medium" if len(local) >= 3 else "low"


# ── Correction / confirmation helpers ─────────────────────────────────────────

def parse_hyphen_spelled_email(text: str) -> Optional[str]:
    """
    Parse hyphen/letter-spelled emails from voice or assistant readback.

    Example: b-a-s-h-i-s-u-l-t-a-n-7-6-6-@-g-m-a-i-l-dot-c-o-m
    """
    if not text:
        return None
    t = text.strip().lower()
    if not (
        re.search(r"[a-z0-9]-[a-z0-9]", t)
        or "-at-" in t
        or "@-" in t
        or "-@" in t
    ):
        return None
    t = re.sub(r"\s+", "", t)
    t = t.replace("-at-", "@").replace("@-", "@").replace("-@", "@")
    t = re.sub(r"-dot-", ".", t)
    t = re.sub(r"g-m-a-i-l", "gmail", t)
    t = re.sub(r"y-a-h-o-o", "yahoo", t)
    t = re.sub(r"h-o-t-m-a-i-l", "hotmail", t)
    t = re.sub(r"o-u-t-l-o-o-k", "outlook", t)
    t = re.sub(r"i-c-l-o-u-d", "icloud", t)
    t = re.sub(r"\.c-o-m$", ".com", t)
    t = re.sub(r"\.o-r-g$", ".org", t)
    t = re.sub(r"\.c-o$", ".co", t)
    t = re.sub(r"-", "", t)
    t = t.replace("dotcom", ".com")
    if re.match(r"^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$", t, re.I):
        return t.lower()
    return None


def is_repeat_email_request(text: str) -> bool:
    return bool(_REPEAT_EMAIL_PAT.search(text or ""))


def is_email_spell_request(text: str) -> bool:
    return bool(_SPELL_EMAIL_PAT.search(text or ""))


def is_email_correction(text: str) -> bool:
    """True if the caller is rejecting / correcting the last captured email."""
    t = (text or "").strip()
    if not t:
        return False
    if re.match(r"^\s*(yes|yeah|yep)\b", t, re.I) and not re.search(
        r"\b(wrong|not correct|incorrect|no)\b", t, re.I
    ):
        return False
    return bool(_CORRECTION_PATS.search(text))


def is_email_confirmation(text: str) -> bool:
    """True if the caller is confirming the pending email candidate."""
    t = (text or "").strip()
    if not t:
        return False
    if is_supplying_email_address(text):
        return False
    if _CORRECTION_PATS.search(text):
        return False
    if re.match(r"^\s*no\b", t, re.I):
        return False
    if re.search(r"\bnot\s+fine\b", t, re.I):
        return False
    return bool(_CONFIRMATION_PATS.search(t))


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
