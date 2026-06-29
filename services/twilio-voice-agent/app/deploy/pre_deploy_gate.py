"""
Pre-deploy health gate — testable production readiness checks.

Used by scripts/pre_deploy_health_gate.py. Does not change runtime business logic.
"""
from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

SERVICE_ROOT = Path(__file__).resolve().parents[1]
PYTEST_EXCLUDE = "not shopify_live and not twilio_live and not resend_live and not slow"


@dataclass
class GateCheck:
    name: str
    passed: bool
    critical: bool
    detail: str = ""


def _settings():
    from app.config import get_settings

    return get_settings()


def check_app_env_production(settings=None) -> GateCheck:
    s = settings or _settings()
    env = (s.APP_ENV or "").strip().lower()
    ok = env == "production"
    return GateCheck(
        "APP_ENV=production",
        ok,
        critical=False,
        detail=f"APP_ENV={env!r}" + ("" if ok else " (expected production for prod deploy)"),
    )


def check_redis(settings=None) -> GateCheck:
    s = settings or _settings()
    if s.is_production and not (s.REDIS_URL or "").strip():
        return GateCheck("REDIS_URL configured", False, critical=True, detail="REDIS_URL missing")
    if not (s.REDIS_URL or "").strip():
        return GateCheck("REDIS_URL reachable", True, critical=False, detail="skipped (not configured)")

    async def _ping() -> bool:
        from app.state.session_store import get_redis_client

        client = await get_redis_client()
        if client is None:
            return False
        await client.ping()
        return True

    try:
        ok = asyncio.run(_ping())
    except Exception as exc:
        return GateCheck("REDIS_URL reachable", False, critical=True, detail=type(exc).__name__)
    return GateCheck(
        "REDIS_URL reachable",
        ok,
        critical=s.is_production,
        detail="ping ok" if ok else "ping failed",
    )


def check_postgres(settings=None) -> GateCheck:
    s = settings or _settings()
    if not (s.DATABASE_URL or "").strip():
        return GateCheck("Postgres reachable", True, critical=False, detail="skipped (DATABASE_URL unset)")

    async def _ping() -> bool:
        from app.db.connection import get_pool

        pool = await get_pool()
        if pool is None:
            return False
        async with pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
        return True

    try:
        ok = asyncio.run(_ping())
    except Exception as exc:
        return GateCheck("Postgres reachable", False, critical=bool(s.STRICT_POSTGRES), detail=type(exc).__name__)
    return GateCheck("Postgres reachable", ok, critical=bool(s.STRICT_POSTGRES), detail="SELECT 1 ok" if ok else "failed")


def check_shopify(settings=None) -> GateCheck:
    s = settings or _settings()
    ok = bool(s.SHOPIFY_SHOP_DOMAIN and s.SHOPIFY_ADMIN_ACCESS_TOKEN)
    return GateCheck(
        "Shopify configured",
        ok,
        critical=s.is_production,
        detail="domain+token set" if ok else "SHOPIFY_SHOP_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN missing",
    )


def check_openai(settings=None) -> GateCheck:
    s = settings or _settings()
    ok = bool(s.OPENAI_API_KEY)
    return GateCheck(
        "OpenAI configured",
        ok,
        critical=s.is_production,
        detail="OPENAI_API_KEY set" if ok else "OPENAI_API_KEY missing",
    )


def check_resend(settings=None) -> GateCheck:
    s = settings or _settings()
    ok = bool(s.RESEND_API_KEY and s.RESEND_FROM_EMAIL)
    return GateCheck(
        "Resend configured",
        ok,
        critical=s.is_production,
        detail="RESEND_API_KEY+FROM set" if ok else "RESend credentials missing",
    )


def check_support_email(settings=None) -> GateCheck:
    s = settings or _settings()
    if s.is_production and s.SUPPORT_ESCALATION_ENABLED and not (s.SUPPORT_EMAIL or "").strip():
        return GateCheck(
            "SUPPORT_EMAIL configured",
            False,
            critical=True,
            detail="required when APP_ENV=production and SUPPORT_ESCALATION_ENABLED=true",
        )
    ok = bool((s.SUPPORT_EMAIL or "").strip()) or not s.SUPPORT_ESCALATION_ENABLED or not s.is_production
    return GateCheck(
        "SUPPORT_EMAIL configured",
        ok,
        critical=s.is_production and s.SUPPORT_ESCALATION_ENABLED,
        detail=(s.SUPPORT_EMAIL[:3] + "***") if s.SUPPORT_EMAIL else "not required or unset",
    )


def check_twilio(settings=None) -> GateCheck:
    s = settings or _settings()
    ok = bool(s.TWILIO_ACCOUNT_SID and s.TWILIO_AUTH_TOKEN)
    return GateCheck(
        "Twilio configured",
        ok,
        critical=s.is_production,
        detail="SID+token set" if ok else "TWILIO credentials missing",
    )


def check_voice_commerce_runtime(settings=None) -> GateCheck:
    s = settings or _settings()
    commerce_on = bool(getattr(s, "VOICE_COMMERCE_RUNTIME_ENABLED", False))
    orchestrator_off = not bool(getattr(s, "VOICE_ORCHESTRATOR_ENABLED", True))
    legacy_off = not bool(getattr(s, "VOICE_LEGACY_RUNTIME_FALLBACK_ENABLED", True))
    ok = commerce_on and orchestrator_off and legacy_off
    return GateCheck(
        "Canonical voice commerce runtime",
        ok,
        critical=s.is_production,
        detail=(
            f"commerce={commerce_on} orchestrator={not orchestrator_off} "
            f"legacy_fallback={not legacy_off}"
        ),
    )


def check_legacy_fallback_policy(settings=None) -> GateCheck:
    s = settings or _settings()
    enabled = bool(getattr(s, "VOICE_LEGACY_RUNTIME_FALLBACK_ENABLED", True))
    explicit = os.environ.get("VOICE_LEGACY_RUNTIME_FALLBACK_ENABLED") is not None
    if s.is_production and enabled and not explicit:
        return GateCheck(
            "Legacy fallback policy explicit",
            False,
            critical=False,
            detail="VOICE_LEGACY_RUNTIME_FALLBACK_ENABLED=true but env var not explicitly set in deploy",
        )
    return GateCheck(
        "Legacy fallback policy explicit",
        True,
        critical=False,
        detail=f"fallback_enabled={enabled} explicit_env={explicit}",
    )


def check_api_docs_disabled(settings=None) -> GateCheck:
    s = settings or _settings()
    if not s.is_production:
        return GateCheck("API docs disabled in production", True, critical=False, detail="not production")
    ok = not s.api_docs_enabled
    return GateCheck(
        "API docs disabled in production",
        ok,
        critical=True,
        detail=f"api_docs_enabled={s.api_docs_enabled}",
    )


def check_admin_debug_disabled(settings=None) -> GateCheck:
    s = settings or _settings()
    allow = os.environ.get("ALLOW_ADMIN_DEBUG_IN_PRODUCTION", "").lower() in ("1", "true", "yes")
    if not s.is_production:
        return GateCheck("Admin debug disabled in production", True, critical=False, detail="not production")
    if s.ENABLE_ADMIN_DEBUG_ENDPOINTS and not allow:
        return GateCheck(
            "Admin debug disabled in production",
            False,
            critical=True,
            detail="ENABLE_ADMIN_DEBUG_ENDPOINTS=true without ALLOW_ADMIN_DEBUG_IN_PRODUCTION",
        )
    return GateCheck(
        "Admin debug disabled in production",
        True,
        critical=False,
        detail=f"admin_debug={s.ENABLE_ADMIN_DEBUG_ENDPOINTS} allow_flag={allow}",
    )


def check_otel(settings=None) -> GateCheck:
    s = settings or _settings()
    if s.OTEL_ENABLED and not (s.OTEL_EXPORTER_OTLP_ENDPOINT or "").strip():
        return GateCheck(
            "OTEL endpoint configured",
            False,
            critical=False,
            detail="OTEL_ENABLED=true but OTEL_EXPORTER_OTLP_ENDPOINT empty",
        )
    return GateCheck(
        "OTEL endpoint configured",
        True,
        critical=False,
        detail=f"otel_enabled={s.OTEL_ENABLED}",
    )


def check_public_base_url(settings=None) -> GateCheck:
    s = settings or _settings()
    url = (s.PUBLIC_BASE_URL or "").strip()
    if s.is_production and not url.startswith("https://"):
        return GateCheck(
            "PUBLIC_BASE_URL https",
            False,
            critical=True,
            detail=f"PUBLIC_BASE_URL={url[:30]}...",
        )
    return GateCheck("PUBLIC_BASE_URL https", True, critical=s.is_production, detail=url[:40] or "unset")


def check_ws_auth(settings=None) -> GateCheck:
    s = settings or _settings()
    if s.is_production and not s.WS_TOKEN_VALIDATION_ENABLED:
        return GateCheck(
            "WS token validation enabled",
            False,
            critical=True,
            detail="WS_TOKEN_VALIDATION_ENABLED=false in production",
        )
    secret_ok = bool(s.ws_token_secret)
    return GateCheck(
        "WS token validation enabled",
        secret_ok or not s.WS_TOKEN_VALIDATION_ENABLED,
        critical=s.is_production,
        detail=f"validation={s.WS_TOKEN_VALIDATION_ENABLED} secret_configured={secret_ok}",
    )


def run_pytest_gate(*, quick: bool = False) -> GateCheck:
    cmd = [
        sys.executable,
        "-m",
        "pytest",
        "-q",
        "--tb=no",
        "-m",
        PYTEST_EXCLUDE,
    ]
    if quick:
        cmd.extend(["app/tests/test_step13_production_deployment.py", "app/tests/test_step2_hardening.py"])
    try:
        r = subprocess.run(
            cmd,
            cwd=str(SERVICE_ROOT),
            capture_output=True,
            text=True,
            timeout=900,
        )
    except subprocess.TimeoutExpired:
        return GateCheck("Pytest gate", False, critical=True, detail="timeout")
    ok = r.returncode == 0
    tail = (r.stdout or r.stderr or "").strip().splitlines()[-1:] or [""]
    return GateCheck("Pytest gate", ok, critical=True, detail=tail[0][:120])


def run_all_checks(
    settings=None,
    *,
    skip_tests: bool = False,
    quick_tests: bool = False,
    production_mode: Optional[bool] = None,
) -> list[GateCheck]:
    s = settings or _settings()
    is_prod = production_mode if production_mode is not None else s.is_production

    checks = [
        check_redis(s),
        check_postgres(s),
        check_shopify(s),
        check_openai(s),
        check_resend(s),
        check_support_email(s),
        check_twilio(s),
        check_voice_commerce_runtime(s),
        check_legacy_fallback_policy(s),
        check_api_docs_disabled(s),
        check_admin_debug_disabled(s),
        check_otel(s),
        check_public_base_url(s),
        check_ws_auth(s),
    ]
    if is_prod:
        checks.insert(0, check_app_env_production(s))
    if not skip_tests and not s.is_test:
        checks.append(run_pytest_gate(quick=quick_tests))
    return checks


def gate_passed(checks: list[GateCheck]) -> bool:
    return all(c.passed or not c.critical for c in checks)


def critical_failures(checks: list[GateCheck]) -> list[GateCheck]:
    return [c for c in checks if not c.passed and c.critical]
