"""Catalog not-found fallback escalation inside voice_commerce_runtime."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.agent_runtime.isbn_short_circuit import try_title_catalog_short_circuit
from app.agent_runtime.not_found_escalation_flow import (
    CATALOG_NOT_FOUND_FALLBACK_MESSAGE,
    _MSG_ASK_TITLE_AFTER_ISBN_FAIL,
    prepare_catalog_not_found_fallback_escalation,
    record_catalog_search_failure,
    should_trigger_catalog_not_found_escalation,
)
from app.conversation.call_memory import get_call_memory
from app.runtime.voice_commerce_runtime import VoiceCommerceRuntime
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    base = dict(
        session_id="sess_cat_nf",
        call_sid="CACATNF1",
        from_number="+15551234001",
        to_number="+15559994001",
    )
    base.update(kwargs)
    return SessionState(**base)


def test_isbn_fail_alone_asks_for_title():
    session = _session()
    record_catalog_search_failure(session, isbn="9780000000001")
    assert not should_trigger_catalog_not_found_escalation(session, isbn="9780000000001")


def test_title_fail_after_isbn_triggers_escalation():
    session = _session()
    record_catalog_search_failure(session, isbn="9780000000001")
    record_catalog_search_failure(session, query="Rare Book XYZ")
    assert should_trigger_catalog_not_found_escalation(session, isbn="")


def test_prepare_escalation_stages_handoff_and_memory():
    session = _session()
    msg = prepare_catalog_not_found_fallback_escalation(
        session,
        user_text="looking for rare book",
        query="Rare Book XYZ",
    )
    assert msg == CATALOG_NOT_FOUND_FALLBACK_MESSAGE
    assert session.awaiting_not_found_escalation_email is True
    assert session.email_capture_mode == "email_capture"
    memory = get_call_memory(session)
    assert any("support escalation" in f.lower() for f in memory.important_facts)


@pytest.mark.asyncio
async def test_title_not_found_uses_fallback_message():
    session = _session()
    with patch(
        "app.agent_runtime.llm_tools._catalog_search",
        new_callable=AsyncMock,
        return_value=json.dumps({"results": [], "count": 0}),
    ):
        with patch(
            "app.agent_runtime.product_resolution.similarity_engine",
            return_value=[],
        ):
            result = await try_title_catalog_short_circuit(
                session,
                "I'm looking for Rare Book XYZ-999",
            )

    assert result is not None
    assert result.catalog_not_found_escalation is True
    assert result.force_reply == CATALOG_NOT_FOUND_FALLBACK_MESSAGE
    assert session.awaiting_not_found_escalation_email is True


@pytest.mark.asyncio
async def test_isbn_not_found_asks_title_before_escalation():
    session = _session()
    oos_payload = json.dumps({"found": False, "isbn": "9780000000001"})
    with patch(
        "app.tools.shopify_tools.search_product_by_isbn",
        new_callable=AsyncMock,
        return_value=oos_payload,
    ):
        with patch(
            "app.agent_runtime.product_resolution.similarity_engine",
            return_value=[],
        ):
            from app.agent_runtime.product_resolution import (
                match_product,
                product_resolution_to_short_circuit,
            )

            resolution = await match_product(session, isbn="9780000000001")
            result = await product_resolution_to_short_circuit(
                session,
                "9780000000001",
                resolution,
                isbn="9780000000001",
            )

    assert result is not None
    assert result.force_reply == _MSG_ASK_TITLE_AFTER_ISBN_FAIL
    assert not result.catalog_not_found_escalation
    assert not session.awaiting_not_found_escalation_email


@pytest.mark.asyncio
async def test_runtime_handler_skips_llm_finalize():
    runtime = VoiceCommerceRuntime(settings=type("S", (), {"OPENAI_API_KEY": "k"})())
    session = _session()
    prepare_catalog_not_found_fallback_escalation(
        session,
        user_text="rare book",
        query="Rare Book",
    )
    sent: list[dict] = []

    async def capture(msg: dict):
        sent.append(msg)

    with patch.object(runtime._brain, "finalize_response") as mock_finalize:
        mock_finalize.side_effect = AssertionError("LLM finalize must not run")
        result = await runtime._handle_catalog_not_found_fallback(
            session,
            "rare book",
            capture,
            force_reply=CATALOG_NOT_FOUND_FALLBACK_MESSAGE,
            sid="CACATNF1",
        )

    assert "cannot" in result.response_text.lower()
    assert sent
    assert sent[0].get("interruptible") is False
