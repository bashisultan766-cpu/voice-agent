"""Workflow transition observability — side-effect only events."""
from __future__ import annotations

import json
import logging

import pytest

from app.agent_runtime.workflow_contracts import (
    PRODUCT_SEARCH_WORKFLOW,
    WorkflowViolationError,
    validate_workflow_call,
    workflow_execution,
)
from app.observability.workflow_events import (
    STEP_PRODUCT_SEARCH_STARTED,
    STEP_WORKFLOW_VIOLATION_DETECTED,
    emit_event,
)


def test_emit_event_logs_structured_payload(caplog: pytest.LogCaptureFixture):
    caplog.set_level(logging.INFO, logger="app.observability.workflow_events")

    emit_event({
        "event_type": "workflow_transition",
        "domain": "product_search",
        "step": STEP_PRODUCT_SEARCH_STARTED,
        "input_type": "title",
        "outcome": "unknown",
        "metadata": {"route": "title_resolve"},
    })

    assert any("workflow_transition" in r.message for r in caplog.records)
    payload_records = [r for r in caplog.records if "workflow_transition step=" in r.message]
    assert payload_records
    assert STEP_PRODUCT_SEARCH_STARTED in payload_records[0].message


def test_emit_event_includes_session_metadata(caplog: pytest.LogCaptureFixture):
    caplog.set_level(logging.INFO, logger="app.observability.workflow_events")

    class _Session:
        call_sid = "CA1234567890"
        session_id = "sess-abc"

    emit_event(
        {
            "event_type": "workflow_transition",
            "domain": "support",
            "step": "email_captured_silently",
            "input_type": "email",
            "outcome": "success",
            "metadata": {},
        },
        session=_Session(),
    )
    assert any("sess-abc" in r.message or "CA123456" in r.message for r in caplog.records)


def test_workflow_violation_emits_event(caplog: pytest.LogCaptureFixture):
    caplog.set_level(logging.INFO)

    with workflow_execution(PRODUCT_SEARCH_WORKFLOW):
        with pytest.raises(WorkflowViolationError):
            validate_workflow_call(PRODUCT_SEARCH_WORKFLOW, "_catalog_search")

    assert any(
        STEP_WORKFLOW_VIOLATION_DETECTED in r.message
        for r in caplog.records
    )
