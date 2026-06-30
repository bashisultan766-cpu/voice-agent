"""Canonical three-domain voice workflow architecture."""
from __future__ import annotations

from app.agent_runtime.voice_workflows import (
    ORDER_WORKFLOW,
    PRODUCT_SEARCH_WORKFLOW,
    SUPPORT_HANDOFF_WORKFLOW,
    VOICE_WORKFLOWS_VERSION,
    execute_product_search_workflow,
    execute_support_handoff_workflow,
)


def test_only_three_domain_workflows():
    assert ORDER_WORKFLOW == "order_workflow"
    assert PRODUCT_SEARCH_WORKFLOW == "product_search_workflow"
    assert SUPPORT_HANDOFF_WORKFLOW == "support_handoff_workflow"
    assert VOICE_WORKFLOWS_VERSION


def test_product_search_executor_is_callable():
    assert callable(execute_product_search_workflow)


def test_support_handoff_executor_is_callable():
    assert callable(execute_support_handoff_workflow)
