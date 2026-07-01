"""Pytest configuration — skip legacy runtime tests removed in canonical refactor."""
from __future__ import annotations

import os
from unittest.mock import patch

import pytest

# Keep pytest isolated from production .env on VPS (APP_ENV=production, Redis, etc.).
os.environ["APP_ENV"] = "test"
os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ["OPENAI_MODEL"] = "gpt-4o"

LEGACY_TEST_PREFIXES = (
    "test_pipeline",
    "test_worker",
    "test_workers",
    "test_orchestrator",
    "test_composer",
    "test_intent_router",
    "test_latency",
    "test_v41_",
    "test_v42_",
    "test_v43_",
    "test_v44_",
    "test_v45_",
    "test_v46_",
    "test_v47_",
    "test_v48_",
    "test_v49_",
    "test_v410",
    "test_v411",
    "test_v412",
    "test_v413",
    "test_v414",
    "test_v415",
    "test_v416",
    "test_v417",
    "test_v418",
    "test_v419",
    "test_v431",
    "test_v439",
    "test_step3_",
    "test_step4_",
    "test_step6_",
    "test_step8_",
    "test_step10_",
    "test_emergency_",
    "test_realtime_voice",
    "eric_composer_mocks",
)


def pytest_ignore_collect(collection_path, config):
    name = collection_path.name
    for prefix in LEGACY_TEST_PREFIXES:
        if name.startswith(prefix):
            return True
    return False


@pytest.fixture(autouse=True)
def _clear_settings_cache():
    from app.config import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture(autouse=True)
def _isolate_escalation_idempotency():
    """Escalation idempotency uses Redis on VPS — isolate each test to in-memory store."""
    from app.escalation import product_not_found_escalation as pne

    pne._STORE.clear()
    pne._SYNC_REDIS = None
    with patch.object(pne, "_get_sync_redis", return_value=None):
        yield
    pne._STORE.clear()
    pne._SYNC_REDIS = None
