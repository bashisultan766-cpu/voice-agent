"""Pytest configuration — skip legacy runtime tests removed in canonical refactor."""
from __future__ import annotations

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
