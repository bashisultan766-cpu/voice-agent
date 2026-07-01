"""
Step 13 — production deployment maturity tests.
"""
from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.deploy.pre_deploy_gate import (
    check_admin_debug_disabled,
    check_api_docs_disabled,
    check_redis,
    check_support_email,
    gate_passed,
    run_all_checks,
)
from app.main import create_app

REPO_ROOT = Path(__file__).resolve().parents[4]


# ── 1–3. Pre-deploy gate ─────────────────────────────────────────────────────


def test_pre_deploy_gate_fails_when_redis_missing_in_production():
    s = Settings(APP_ENV="production", REDIS_URL="", DEBUG=False)
    check = check_redis(s)
    assert not check.passed
    assert check.critical


def test_pre_deploy_gate_fails_when_support_email_missing():
    s = Settings(
        APP_ENV="production",
        SUPPORT_ESCALATION_ENABLED=True,
        SUPPORT_EMAIL="",
        DEBUG=False,
    )
    check = check_support_email(s)
    assert not check.passed
    assert check.critical


def test_pre_deploy_gate_passes_in_test_mode():
    s = Settings(
        APP_ENV="test",
        REDIS_URL="",
        SUPPORT_EMAIL="",
        SUPPORT_ESCALATION_ENABLED=True,
        OPENAI_API_KEY="",
        SHOPIFY_SHOP_DOMAIN="",
    )
    checks = run_all_checks(s, skip_tests=True, production_mode=False)
    assert gate_passed(checks)


# ── 4. Staging smoke dry-run ─────────────────────────────────────────────────


def test_staging_smoke_tests_dry_run_mode():
    import importlib.util
    import sys

    script = Path(__file__).resolve().parents[2] / "scripts" / "staging_smoke_tests.py"
    spec = importlib.util.spec_from_file_location("staging_smoke_mod", script)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["staging_smoke_mod"] = mod
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    results = mod.run_smoke_tests(dry_run=True)
    assert len(results) >= 10
    assert all(r.passed for r in results)


# ── 5–7. Security defaults ───────────────────────────────────────────────────


def test_health_endpoint_does_not_expose_secrets():
    get_settings.cache_clear()
    with patch.dict(
        os.environ,
        {
            "APP_ENV": "test",
            "OPENAI_API_KEY": "sk-super-secret-key",
            "SHOPIFY_ADMIN_ACCESS_TOKEN": "shpat_super_secret",
            "TWILIO_AUTH_TOKEN": "twilio_secret_token",
        },
        clear=False,
    ):
        get_settings.cache_clear()
        client = TestClient(create_app())
        body = client.get("/health").text
        assert "sk-super-secret" not in body
        assert "shpat_super_secret" not in body
        assert "twilio_secret_token" not in body


def test_production_docs_disabled():
    s = Settings(APP_ENV="production", DEBUG=False, ENABLE_API_DOCS=True)
    check = check_api_docs_disabled(s)
    assert check.passed
    assert not s.api_docs_enabled


def test_admin_debug_disabled_by_default():
    s = Settings(APP_ENV="production", ENABLE_ADMIN_DEBUG_ENDPOINTS=False)
    check = check_admin_debug_disabled(s)
    assert check.passed
    get_settings.cache_clear()
    with patch.dict(os.environ, {"APP_ENV": "production", "ENABLE_ADMIN_DEBUG_ENDPOINTS": "false"}, clear=False):
        get_settings.cache_clear()
        client = TestClient(create_app())
        r = client.get("/admin/analytics/summary", headers={"X-Admin-Key": "any"})
        assert r.status_code == 404


# ── 8–9. Runbook / audit docs exist ──────────────────────────────────────────


def test_canary_runbook_file_exists():
    path = REPO_ROOT / "docs" / "CANARY_ROLLBACK_RUNBOOK.md"
    assert path.exists()
    text = path.read_text(encoding="utf-8")
    assert "rollback" in text.lower()
    assert "metrics to watch" in text.lower()


def test_multi_worker_audit_file_exists():
    path = REPO_ROOT / "docs" / "MULTI_WORKER_SAFETY_AUDIT.md"
    assert path.exists()
    text = path.read_text(encoding="utf-8")
    assert "sticky" in text.lower()
    assert "redis" in text.lower()
