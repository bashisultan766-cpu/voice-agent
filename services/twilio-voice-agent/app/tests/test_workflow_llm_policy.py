"""Product/support workflows must never delegate routing to the LLM."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from app.agent_runtime.workflow_contracts import (
    PRODUCT_SEARCH_WORKFLOW,
    SUPPORT_HANDOFF_WORKFLOW,
    workflow_execution,
)
from app.runtime.fast_classifier import classify
from app.runtime.voice_commerce_runtime import _llm_blocked_for_workflow
from app.state.models import SessionState
from app.tests.test_voice_commerce_runtime import _build_runtime, _text_response


def _session(**kwargs) -> SessionState:
    return SessionState(
        session_id="s",
        call_sid="CA_TEST",
        from_number="+1",
        to_number="+2",
        **kwargs,
    )


def test_classifier_product_search_skips_llm():
    result = classify("I need Game of Thrones")
    assert result.is_product_search
    assert result.skip_llm
    assert result.action == "instant"


def test_llm_blocked_for_product_workflow_domain():
    session = _session()
    classification = classify("I need Game of Thrones")
    with workflow_execution(PRODUCT_SEARCH_WORKFLOW):
        assert _llm_blocked_for_workflow(
            session,
            "I need Game of Thrones",
            "",
            classification,
            PRODUCT_SEARCH_WORKFLOW,
        )


def test_llm_blocked_for_support_escalation_session():
    session = _session(awaiting_not_found_escalation_email=True)
    classification = classify("bashi at gmail dot com", turn_mode="email")
    assert _llm_blocked_for_workflow(
        session,
        "bashi at gmail dot com",
        "email",
        classification,
        SUPPORT_HANDOFF_WORKFLOW,
    )


@pytest.mark.asyncio
async def test_support_handoff_turn_never_calls_openai():
    runtime = _build_runtime([_text_response("LLM must not run during support handoff")])
    session = _session(
        awaiting_not_found_escalation_email=True,
        pending_not_found_escalation={
            "reason": "product_not_found",
            "query": "Rare Book",
            "email_capture_mode": "silent",
        },
    )
    sent: list[dict] = []

    async def send(msg: dict):
        sent.append(msg)

    with patch(
        "app.escalation.support_handoff.send_support_handoff",
        new_callable=AsyncMock,
        return_value=type(
            "R",
            (),
            {"success": True, "result": {"customer_message": "Done"}},
        )(),
    ):
        await runtime.handle_turn(
            session,
            "Maria Lopez and my email is maria at example dot com",
            send,
            assembled_turn_mode="email",
        )

    assert runtime._brain._client.chat.completions.calls == []
