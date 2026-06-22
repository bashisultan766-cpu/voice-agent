"""
CallerProfile and CallSessionMemory persistence.

Primary store: Redis.  Fallback: in-memory dict (single-process only).
Interface is clean enough to swap in a SQLAlchemy repo later via DATABASE_URL.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Optional, TYPE_CHECKING

from ..state.session_store import cache_get, cache_set, cache_delete
from .models import CallerProfile, CallSessionMemory

if TYPE_CHECKING:
    from ..state.models import SafeCallerContext, SessionState

logger = logging.getLogger(__name__)

_PROFILE_TTL = 60 * 60 * 24 * 30   # 30 days
_SESSION_TTL = 60 * 60 * 24         # 24 hours

_PHONE_DIGITS = re.compile(r"\D")


def normalize_phone(raw: str) -> str:
    """Strip all non-digit characters. '+15551234567' → '15551234567'."""
    return _PHONE_DIGITS.sub("", raw)


def mask_email(email: str) -> str:
    """
    Mask an email for safe display.

    'darren@example.com' → 'd***n@example.com'
    'ab@example.com'     → 'a***b@example.com'
    'a@example.com'      → 'a***@example.com'
    ''                   → '***'
    """
    if not email or "@" not in email:
        return "***"
    local, domain = email.split("@", 1)
    if len(local) <= 1:
        return f"{local}***@{domain}"
    return f"{local[0]}***{local[-1]}@{domain}"


def build_safe_caller_context(
    session: "SessionState",
    greeted_already: bool = False,
) -> "SafeCallerContext":
    """
    Build a SafeCallerContext from the current session.

    The context is safe to include in the OpenAI system prompt:
    - Email is always masked.
    - No payment info, full transcripts, or raw Shopify data.
    - Verification flags reflect THIS call only.
    """
    from ..state.models import SafeCallerContext

    masked_email = mask_email(session.caller_email) if session.caller_email else ""

    return SafeCallerContext(
        is_returning_caller=session.is_returning_caller,
        caller_name=session.caller_name,
        call_count=session.caller_call_count if session.caller_call_count > 0 else None,
        preferred_email_masked=masked_email,
        last_summary=session.caller_last_summary,
        last_order_number=session.last_order_number,
        verified_email=session.verified_email,
        verified_phone=session.verified_phone,
        greeted_already=greeted_already,
    )


# ── CallerProfile ─────────────────────────────────────────────────────────────

async def get_caller_profile(phone_number: str) -> Optional[CallerProfile]:
    norm = normalize_phone(phone_number)
    if not norm:
        return None
    data = await cache_get(f"caller:profile:{norm}")
    if not data:
        return None
    try:
        return CallerProfile.from_dict(data)
    except Exception as exc:
        logger.warning("Corrupt caller profile for %s: %s", norm[:4] + "***", exc)
        return None


async def save_caller_profile(profile: CallerProfile) -> None:
    profile.updated_at = datetime.now(timezone.utc).isoformat()
    await cache_set(f"caller:profile:{profile.normalized_phone}", profile.to_dict(), _PROFILE_TTL)


async def upsert_caller_profile(
    phone_number: str,
    display_name: str = "",
    preferred_email: str = "",
    shopify_customer_id: str = "",
    last_order_id: str = "",
    last_order_number: str = "",
    summary: str = "",
) -> CallerProfile:
    """Load existing profile (or create new) and apply updates."""
    norm = normalize_phone(phone_number)
    existing = await get_caller_profile(phone_number)

    if existing:
        if display_name:
            existing.display_name = display_name
        if preferred_email:
            existing.preferred_email = preferred_email
        if shopify_customer_id:
            existing.shopify_customer_id = shopify_customer_id
        if last_order_id:
            existing.last_order_id = last_order_id
        if last_order_number:
            existing.last_order_number = last_order_number
        if summary:
            existing.last_summary = summary[:300]
        existing.call_count += 1
        existing.last_seen_at = datetime.now(timezone.utc).isoformat()
        await save_caller_profile(existing)
        return existing

    profile = CallerProfile(
        id=norm,
        phone_number=phone_number,
        normalized_phone=norm,
        display_name=display_name,
        preferred_email=preferred_email,
        shopify_customer_id=shopify_customer_id,
        last_order_id=last_order_id,
        last_order_number=last_order_number,
        last_summary=summary[:300] if summary else "",
        call_count=1,
    )
    await save_caller_profile(profile)
    return profile


async def delete_caller_profile(phone_number: str) -> None:
    norm = normalize_phone(phone_number)
    await cache_delete(f"caller:profile:{norm}")


# ── CallSessionMemory ─────────────────────────────────────────────────────────

async def get_session_memory(call_sid: str) -> Optional[CallSessionMemory]:
    data = await cache_get(f"caller:session:{call_sid}")
    if not data:
        return None
    try:
        return CallSessionMemory.from_dict(data)
    except Exception as exc:
        logger.warning("Corrupt session memory for %s: %s", call_sid[:8] + "***", exc)
        return None


async def save_session_memory(mem: CallSessionMemory) -> None:
    mem.updated_at = datetime.now(timezone.utc).isoformat()
    await cache_set(f"caller:session:{mem.call_sid}", mem.to_dict(), _SESSION_TTL)


async def delete_session_memory(call_sid: str) -> None:
    await cache_delete(f"caller:session:{call_sid}")
