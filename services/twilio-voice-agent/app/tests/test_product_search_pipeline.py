"""Single product search pipeline — legacy route guards and single-router enforcement."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from app.agent_runtime.voice_workflows import ProductSearchTurnResult
from app.agent_runtime.workflow_contracts import (
    CANONICAL_PRODUCT_SEARCH_HANDLER,
    WorkflowViolationError,
    workflow_execution,
)
from app.observability.workflow_events import STEP_LEGACY_ROUTE_ATTEMPT_DETECTED
from app.runtime import voice_commerce_runtime as vcr
from app.runtime.fast_classifier import ClassificationResult
from app.state.models import SessionState


def _session() -> SessionState:
    return SessionState(
        session_id="s",
        call_sid="CA_PIPE",
        from_number="+1",
        to_number="+2",
    )


def _classification(**kwargs) -> ClassificationResult:
    base = dict(action="brain", reason="test")
    base.update(kwargs)
    return ClassificationResult(**base)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "legacy_fn",
    [
        vcr.title_catalog_hunt,
        vcr.product_catalog_hunt,
        vcr._try_title_catalog_hunt,
        vcr._try_isbn_product_hunt,
    ],
)
async def test_legacy_product_routes_raise_violation(legacy_fn, caplog):
    session = _session()
    with pytest.raises(WorkflowViolationError):
        await legacy_fn(session, "Game of Thrones")
    assert any(
        STEP_LEGACY_ROUTE_ATTEMPT_DETECTED in rec.message
        or "legacy_route_attempt_detected" in rec.message
        for rec in caplog.records
    )


def test_legacy_route_names_are_guarded():
    assert vcr._LEGACY_PRODUCT_SEARCH_ROUTES == frozenset({
        "title_catalog_hunt",
        "product_catalog_hunt",
        "_try_title_catalog_hunt",
        "_try_isbn_product_hunt",
    })


def test_runtime_exposes_canonical_product_search_router():
    assert hasattr(vcr.VoiceCommerceRuntime, "route_to_product_search_workflow")
    assert hasattr(vcr.VoiceCommerceRuntime, "_route_product_search_once")
    assert not hasattr(vcr.VoiceCommerceRuntime, "_route_product_search_workflow")


def test_canonical_product_search_handler_constant():
    assert CANONICAL_PRODUCT_SEARCH_HANDLER == "execute_product_search_workflow"


@pytest.mark.asyncio
async def test_double_product_router_dispatch_raises():
    runtime = vcr.VoiceCommerceRuntime(settings=type("S", (), {"OPENAI_API_KEY": "k"})())
    session = _session()
    classification = _classification(is_product_search=True, skip_brain=True)

    async def send(_msg: dict) -> None:
        return None

    with patch(
        "app.agent_runtime.voice_workflows.execute_product_search_workflow",
        new_callable=AsyncMock,
        return_value=ProductSearchTurnResult(
            force_reply="Please provide ISBN or book title.",
            route="clarification",
        ),
    ):
        await runtime._route_product_search_once(
            session,
            "I want a book",
            send,
            turn_mode="",
            classification=classification,
            sid="CA_PIP",
        )
        with pytest.raises(WorkflowViolationError, match="MULTI_ROUTER_DETECTED"):
            await runtime._route_product_search_once(
                session,
                "I want a book",
                send,
                turn_mode="",
                classification=classification,
                sid="CA_PIP",
            )


@pytest.mark.asyncio
async def test_try_title_short_circuit_blocked_inside_product_search_workflow():
    from app.agent_runtime.isbn_short_circuit import try_title_catalog_short_circuit

    session = _session()
    with workflow_execution("product_search_workflow"):
        with pytest.raises(WorkflowViolationError):
            await try_title_catalog_short_circuit(session, "Do you have Atomic Habits")
