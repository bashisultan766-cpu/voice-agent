#!/usr/bin/env python3
"""
Staging smoke tests — safe endpoint and policy checks (no live payments).

Usage:
    python scripts/staging_smoke_tests.py
    python scripts/staging_smoke_tests.py --dry-run
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ.setdefault("APP_ENV", "test")
os.environ.setdefault("WS_TOKEN_VALIDATION_ENABLED", "true")
os.environ.setdefault("TWILIO_AUTH_TOKEN", "smoke_test_twilio_secret")
os.environ.setdefault("INTERNAL_ADMIN_KEY", "smoke-admin-key")


@dataclass
class SmokeResult:
    name: str
    passed: bool
    detail: str = ""


def _reset_settings():
    from app.config import get_settings

    get_settings.cache_clear()


def smoke_health_no_secrets() -> SmokeResult:
    from fastapi.testclient import TestClient
    from app.config import Settings, get_settings
    from app.main import create_app

    get_settings.cache_clear()
    with patch.dict(os.environ, {"APP_ENV": "test", "OPENAI_API_KEY": "sk-test"}, clear=False):
        get_settings.cache_clear()
        client = TestClient(create_app())
        r = client.get("/health")
        if r.status_code != 200:
            return SmokeResult("health endpoint", False, f"status={r.status_code}")
        body = r.text
        for secret in ("sk-test", "shpat_", "re_", "TWILIO_AUTH_TOKEN"):
            if secret in body and secret != "sk-test":
                return SmokeResult("health no secrets", False, f"found {secret}")
        if "sk-test" in body:
            return SmokeResult("health no secrets", False, "OPENAI key leaked")
        return SmokeResult("health endpoint", True, "ok")


def smoke_twilio_inbound_twiml() -> SmokeResult:
    from fastapi.testclient import TestClient
    from app.main import create_app

    _reset_settings()
    client = TestClient(create_app())
    with patch.dict(
        os.environ,
        {
            "APP_ENV": "test",
            "VALIDATE_TWILIO_SIGNATURES": "false",
            "PUBLIC_BASE_URL": "https://staging.example.com",
            "WS_TOKEN_VALIDATION_ENABLED": "true",
        },
        clear=False,
    ):
        _reset_settings()
        client = TestClient(create_app())
        r = client.post(
            "/voice/twilio/inbound",
            data={
                "CallSid": "CA_smoke_test",
                "From": "+15551234567",
                "To": "+15559876543",
            },
        )
        if r.status_code != 200:
            return SmokeResult("twilio inbound twiml", False, f"status={r.status_code}")
        if "ConversationRelay" not in r.text and "Connect" not in r.text:
            return SmokeResult("twilio inbound twiml", False, "missing ConversationRelay TwiML")
        if "wss://" not in r.text and "https://" not in r.text:
            return SmokeResult("twilio inbound twiml", False, "missing ws url")
        return SmokeResult("twilio inbound twiml", True, "TwiML ok")


def smoke_ws_token() -> SmokeResult:
    from app.config import get_settings
    from app.security.ws_token import mint_ws_token, validate_ws_token

    _reset_settings()
    token = mint_ws_token(call_sid="CA_smoke", from_number="+15550001111")
    payload = validate_ws_token(token)
    if not payload:
        return SmokeResult("ws token mint/validate", False, "validation failed")
    bad = validate_ws_token(token + "x")
    if bad is not None:
        return SmokeResult("ws token mint/validate", False, "bad token accepted")
    return SmokeResult("ws token mint/validate", True, "ok")


def smoke_product_search_mock() -> SmokeResult:
    async def _fake_dispatch(tool, args, session):
        return json.dumps({"success": True, "products": [], "customer_message": "No matches."})

    from app.state.models import SessionState
    from app.agent_runtime import llm_tools

    session = SessionState(
        session_id="smoke",
        call_sid="CA_smoke",
        from_number="+15550001111",
        to_number="+15550002222",
    )
    import asyncio

    with patch.object(llm_tools, "dispatch", _fake_dispatch):
        raw = asyncio.run(
            llm_tools.dispatch("search_products", {"query": "test book"}, session)
        )
    data = json.loads(raw)
    if not data.get("success"):
        return SmokeResult("product search mock", False, raw[:80])
    return SmokeResult("product search mock", True, "ok")


def smoke_order_privacy_unverified() -> SmokeResult:
    from app.state.models import SessionState
    from app.agent_runtime.tool_runtime_gates import gate_tool_call

    session = SessionState(
        session_id="smoke",
        call_sid="CA_smoke",
        from_number="+15550001111",
        to_number="+15550002222",
    )
    gate = gate_tool_call("lookup_order_status", session)
    if gate is None or gate.allowed:
        return SmokeResult("order privacy unverified", False, "order lookup should be gated")
    return SmokeResult("order privacy unverified", True, gate.reason[:60])


def smoke_payment_safety_blocked() -> SmokeResult:
    from app.state.models import SessionState
    from app.payment.safety import require_confirmed_email

    session = SessionState(
        session_id="smoke",
        call_sid="CA_smoke",
        from_number="+15550001111",
        to_number="+15550002222",
    )
    result = require_confirmed_email(session)
    if result.allowed:
        return SmokeResult("payment safety blocked", False, "should block without email")
    return SmokeResult("payment safety blocked", True, result.reason[:40])


def smoke_facility_policy_lookup() -> SmokeResult:
    async def _fake_dispatch(tool, args, session):
        return json.dumps({"success": True, "policy_summary": "Books allowed.", "customer_message": "OK"})

    from app.state.models import SessionState
    from app.agent_runtime import llm_tools
    import asyncio

    session = SessionState(
        session_id="smoke",
        call_sid="CA_smoke",
        from_number="+15550001111",
        to_number="+15550002222",
    )
    with patch.object(llm_tools, "dispatch", _fake_dispatch):
        raw = asyncio.run(
            llm_tools.dispatch(
                "facility_policy_lookup",
                {"facility_name": "Test Facility"},
                session,
            )
        )
    if not json.loads(raw).get("success"):
        return SmokeResult("facility policy lookup", False, raw[:80])
    return SmokeResult("facility policy lookup", True, "ok")


def smoke_not_found_escalation_dry_run() -> SmokeResult:
    from app.config import Settings
    from app.escalation.models import ProductNotFoundEscalationPayload

    payload = ProductNotFoundEscalationPayload(
        call_sid="CA_smoke",
        requested_type="isbn",
        requested_value="9780000000000",
        customer_email="dry@example.com",
        customer_phone="+15550001111",
    )
    if not payload.idempotency_key():
        return SmokeResult("not-found escalation dry-run", False, "no idempotency key")
    with patch("app.escalation.product_not_found_escalation.get_settings") as gs:
        gs.return_value = Settings(
            APP_ENV="test",
            SUPPORT_ESCALATION_ENABLED=True,
            SUPPORT_EMAIL="support@example.com",
            RESEND_API_KEY="",
        )
        from app.escalation.product_not_found_escalation import create_product_not_found_escalation
        import asyncio

        raw = asyncio.run(
            create_product_not_found_escalation(payload, session=None)
        )
    data = json.loads(raw)
    if data.get("success"):
        return SmokeResult("not-found escalation dry-run", False, "should not send without resend")
    return SmokeResult("not-found escalation dry-run", True, data.get("error_code", "blocked")[:40])


def smoke_analytics_auth() -> SmokeResult:
    from fastapi.testclient import TestClient
    from app.main import create_app

    _reset_settings()
    with patch.dict(
        os.environ,
        {
            "ENABLE_ADMIN_DEBUG_ENDPOINTS": "true",
            "INTERNAL_ADMIN_KEY": "smoke-admin-key",
            "APP_ENV": "test",
        },
        clear=False,
    ):
        _reset_settings()
        client = TestClient(create_app())
        denied = client.get("/admin/analytics/summary")
        if denied.status_code != 403:
            return SmokeResult("analytics auth", False, f"expected 403 got {denied.status_code}")
        ok = client.get(
            "/admin/analytics/summary",
            headers={"X-Admin-Key": "smoke-admin-key"},
        )
        if ok.status_code != 200:
            return SmokeResult("analytics auth", False, f"expected 200 got {ok.status_code}")
    return SmokeResult("analytics auth", True, "key required")


def smoke_production_docs_disabled() -> SmokeResult:
    from app.config import Settings

    s = Settings(APP_ENV="production", DEBUG=False, ENABLE_API_DOCS=True)
    if s.api_docs_enabled:
        return SmokeResult("production docs disabled", False, "docs enabled in production")
    return SmokeResult("production docs disabled", True, "ok")


def smoke_admin_debug_default() -> SmokeResult:
    from app.config import Settings

    s = Settings(APP_ENV="production", ENABLE_ADMIN_DEBUG_ENDPOINTS=False)
    if s.ENABLE_ADMIN_DEBUG_ENDPOINTS:
        return SmokeResult("admin debug default", False, "enabled by default")
    return SmokeResult("admin debug default", True, "disabled")


def run_smoke_tests(*, dry_run: bool = False) -> list[SmokeResult]:
    tests = [
        smoke_health_no_secrets,
        smoke_twilio_inbound_twiml,
        smoke_ws_token,
        smoke_product_search_mock,
        smoke_order_privacy_unverified,
        smoke_payment_safety_blocked,
        smoke_facility_policy_lookup,
        smoke_not_found_escalation_dry_run,
        smoke_analytics_auth,
        smoke_production_docs_disabled,
        smoke_admin_debug_default,
    ]
    if dry_run:
        return [SmokeResult(t.__name__, True, "dry-run skip") for t in tests]
    results: list[SmokeResult] = []
    for fn in tests:
        try:
            results.append(fn())
        except Exception as exc:
            results.append(SmokeResult(fn.__name__, False, type(exc).__name__))
    return results


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="List tests without executing")
    args = parser.parse_args()
    results = run_smoke_tests(dry_run=args.dry_run)
    for r in results:
        status = "PASS" if r.passed else "FAIL"
        print(f"[{status}] {r.name}: {r.detail}")
    passed = all(r.passed for r in results)
    print("staging_smoke_tests:", "PASS" if passed else "FAIL")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
