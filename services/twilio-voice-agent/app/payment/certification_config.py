"""Payment certification configuration (v4.15.0)."""
from __future__ import annotations

import os
from functools import lru_cache

from ..config import get_settings


@lru_cache
def _env() -> str:
    return (os.environ.get("ENVIRONMENT") or os.environ.get("APP_ENV") or "development").lower()


def is_certification_mode() -> bool:
    return bool(get_settings().VOICE_PAYMENT_CERTIFICATION_MODE)


def is_dry_run() -> bool:
    s = get_settings()
    if not s.VOICE_PAYMENT_CERTIFICATION_MODE:
        return True
    return bool(s.VOICE_PAYMENT_CERTIFICATION_DRY_RUN)


def allow_real_checkout() -> bool:
    s = get_settings()
    if not s.VOICE_PAYMENT_CERTIFICATION_MODE:
        return _env() in ("production", "staging") and not is_dry_run()
    return bool(s.VOICE_PAYMENT_CERTIFICATION_ALLOW_REAL_CHECKOUT) and not is_dry_run()


def allow_real_email() -> bool:
    s = get_settings()
    if not s.VOICE_PAYMENT_CERTIFICATION_MODE:
        return _env() in ("production", "staging") and not is_dry_run()
    return bool(s.VOICE_PAYMENT_CERTIFICATION_ALLOW_REAL_EMAIL) and not is_dry_run()


def get_test_email_allowlist() -> frozenset[str]:
    raw = get_settings().VOICE_PAYMENT_CERTIFICATION_TEST_EMAILS or ""
    return frozenset(e.strip().lower() for e in raw.split(",") if e.strip())


def is_email_allowlisted(email: str) -> bool:
    allowlist = get_test_email_allowlist()
    if not allowlist:
        return False
    return (email or "").strip().lower() in allowlist


def max_cart_lines() -> int:
    return max(1, int(get_settings().VOICE_PAYMENT_CERTIFICATION_MAX_CART_LINES or 10))


def idempotency_ttl_seconds() -> int:
    return max(60, int(get_settings().VOICE_PAYMENT_IDEMPOTENCY_TTL_SECONDS or 1800))


def catalog_parallel_limit() -> int:
    return max(1, int(get_settings().VOICE_CATALOG_PARALLEL_SEARCH_LIMIT or 4))


def catalog_identifier_timeout_ms() -> int:
    return max(500, int(get_settings().VOICE_CATALOG_IDENTIFIER_TIMEOUT_MS or 5000))


def certification_summary() -> dict[str, str | bool | int]:
    return {
        "mode": is_certification_mode(),
        "dry_run": is_dry_run(),
        "allow_real_checkout": allow_real_checkout(),
        "allow_real_email": allow_real_email(),
        "allowlist_count": len(get_test_email_allowlist()),
        "max_cart_lines": max_cart_lines(),
        "idempotency_ttl": idempotency_ttl_seconds(),
    }
