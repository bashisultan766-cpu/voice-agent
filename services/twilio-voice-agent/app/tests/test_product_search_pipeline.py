"""Single product search pipeline — legacy route guards."""
from __future__ import annotations

import pytest

from app.agent_runtime.workflow_contracts import WorkflowViolationError
from app.observability.workflow_events import STEP_LEGACY_ROUTE_ATTEMPT_DETECTED
from app.runtime import voice_commerce_runtime as vcr
from app.state.models import SessionState


def _session() -> SessionState:
    return SessionState(
        session_id="s",
        call_sid="CA_PIPE",
        from_number="+1",
        to_number="+2",
    )


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
    assert not hasattr(vcr.VoiceCommerceRuntime, "_route_product_search_workflow")
