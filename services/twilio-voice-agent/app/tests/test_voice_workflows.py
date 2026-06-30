"""Canonical three-domain voice workflow architecture."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest

from app.agent_runtime.voice_workflows import (
    ORDER_WORKFLOW,
    PRODUCT_CLARIFICATION_REPLY,
    PRODUCT_SEARCH_WORKFLOW,
    SUPPORT_HANDOFF_WORKFLOW,
    VOICE_WORKFLOWS_VERSION,
    execute_product_search_workflow,
    execute_support_handoff_workflow,
    has_valid_product_identifier,
)
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    base = dict(
        session_id="s",
        call_sid="CA_WF",
        from_number="+1",
        to_number="+2",
    )
    base.update(kwargs)
    return SessionState(**base)


def test_only_three_domain_workflows():
    assert ORDER_WORKFLOW == "order_workflow"
    assert PRODUCT_SEARCH_WORKFLOW == "product_search_workflow"
    assert SUPPORT_HANDOFF_WORKFLOW == "support_handoff_workflow"
    assert VOICE_WORKFLOWS_VERSION


def test_product_search_executor_is_callable():
    assert callable(execute_product_search_workflow)


def test_support_handoff_executor_is_callable():
    assert callable(execute_support_handoff_workflow)


def test_clarification_reply_is_structured():
    assert PRODUCT_CLARIFICATION_REPLY == "Please provide ISBN or book title."


def test_vague_product_intent_is_not_valid_identifier():
    session = _session()
    assert not has_valid_product_identifier(session, "I want a book")


def test_bare_title_is_not_valid_identifier():
    session = _session()
    assert not has_valid_product_identifier(session, "Game of Thrones")


def test_explicit_title_is_valid_identifier():
    session = _session()
    assert has_valid_product_identifier(session, "Do you have Game of Thrones")


@pytest.mark.asyncio
async def test_workflow_clarifies_without_catalog_search():
    session = _session()
    with patch(
        "app.agent_runtime.workflow_isolation.product_handling_allowed",
        return_value=True,
    ):
        with patch(
            "app.agent_runtime.product_resolution.match_product",
            new_callable=AsyncMock,
        ) as match_product:
            result = await execute_product_search_workflow(session, "I want a book")

    match_product.assert_not_called()
    assert result is not None
    assert result.route == "clarification"
    assert result.force_reply == PRODUCT_CLARIFICATION_REPLY


@pytest.mark.asyncio
async def test_workflow_rejects_partial_isbn_without_search():
    session = _session()
    session.pending_isbn_buffer = "978014312774"
    with patch(
        "app.agent_runtime.workflow_isolation.product_handling_allowed",
        return_value=True,
    ):
        with patch(
            "app.agent_runtime.product_resolution.match_product",
            new_callable=AsyncMock,
        ) as match_product:
            result = await execute_product_search_workflow(
                session,
                "the next digit is 1",
                turn_mode="isbn",
            )

    match_product.assert_not_called()
    assert result is not None
    assert result.route == "clarification"
    assert session.pending_isbn_buffer == ""


@pytest.mark.asyncio
async def test_workflow_searches_only_after_explicit_title():
    session = _session()
    catalog = {
        "results": [{
            "title": "Game of Thrones",
            "variant_id": "v1",
            "price": "12.99",
            "available": True,
            "inventory_quantity": 5,
        }],
        "count": 1,
    }
    with patch(
        "app.agent_runtime.workflow_isolation.product_handling_allowed",
        return_value=True,
    ):
        with patch(
            "app.agent_runtime.llm_tools._catalog_search",
            new_callable=AsyncMock,
            return_value=json.dumps(catalog),
        ):
            with patch(
                "app.agent_runtime.product_resolution.similarity_engine",
                return_value=[],
            ):
                result = await execute_product_search_workflow(
                    session,
                    "I need Game of Thrones",
                )

    assert result is not None
    assert result.route == "title_resolve"
    assert "Game of Thrones" in result.force_reply
