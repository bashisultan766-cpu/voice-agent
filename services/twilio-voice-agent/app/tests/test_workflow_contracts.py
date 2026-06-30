"""Workflow contract enforcement — hard-stop guard tests."""
from __future__ import annotations

import pytest

from app.agent_runtime.workflow_contracts import (
    ORDER_WORKFLOW,
    PRODUCT_SEARCH_WORKFLOW,
    SUPPORT_HANDOFF_WORKFLOW,
    WorkflowViolationError,
    validate_workflow_call,
    workflow_execution,
)


def test_validate_allows_product_search_allowlist():
    with workflow_execution(PRODUCT_SEARCH_WORKFLOW):
        validate_workflow_call(PRODUCT_SEARCH_WORKFLOW, "match_product")


def test_validate_blocks_forbidden_catalog_in_product_search():
    with workflow_execution(PRODUCT_SEARCH_WORKFLOW):
        with pytest.raises(WorkflowViolationError):
            validate_workflow_call(PRODUCT_SEARCH_WORKFLOW, "_catalog_search")


def test_validate_blocks_product_resolution_from_order_workflow():
    with workflow_execution(ORDER_WORKFLOW):
        with pytest.raises(WorkflowViolationError):
            validate_workflow_call(PRODUCT_SEARCH_WORKFLOW, "match_product")


def test_validate_blocks_support_analysis_in_product_search():
    with workflow_execution(PRODUCT_SEARCH_WORKFLOW):
        with pytest.raises(WorkflowViolationError):
            validate_workflow_call(SUPPORT_HANDOFF_WORKFLOW, "analyze_conversation_for_support")


def test_no_enforcement_outside_workflow_domain():
    validate_workflow_call(PRODUCT_SEARCH_WORKFLOW, "match_product")


@pytest.mark.asyncio
async def test_clear_turn_workflow_contract_survives_cross_task_context():
    """Cancelled asyncio tasks must not break the next turn's contract clear."""
    import asyncio

    from app.agent_runtime.workflow_contracts import (
        PRODUCT_SEARCH_WORKFLOW,
        apply_turn_workflow_contract,
        clear_turn_workflow_contract,
    )
    from app.state.models import SessionState

    session = SessionState(
        session_id="s1",
        call_sid="CAcross",
        from_number="+1",
        to_number="+1",
    )

    async def first_turn():
        apply_turn_workflow_contract(session, PRODUCT_SEARCH_WORKFLOW)
        await asyncio.sleep(0.05)

    task = asyncio.create_task(first_turn())
    await asyncio.sleep(0.01)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass

    clear_turn_workflow_contract(session)
    apply_turn_workflow_contract(session, PRODUCT_SEARCH_WORKFLOW)
    clear_turn_workflow_contract(session)
