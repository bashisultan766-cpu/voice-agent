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
