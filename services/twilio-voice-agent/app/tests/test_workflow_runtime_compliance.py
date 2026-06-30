"""Runtime workflow graph compliance — hooks and turn-boundary checks."""
from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from app.agent_runtime.workflow_compiler import (
    WorkflowCompileRuntimeViolation,
    assert_runtime_compliance,
    compile_workflows,
    get_compiled_workflow_graph,
    inject_compiled_graph,
    install_runtime_validation_hooks,
    resolve_turn_entry_node,
)
from app.agent_runtime.workflow_contracts import (
    PRODUCT_SEARCH_WORKFLOW,
    SUPPORT_HANDOFF_WORKFLOW,
    WorkflowViolationError,
    register_validate_workflow_call_hook,
    validate_workflow_call,
    workflow_execution,
)


@pytest.fixture
def compiled_graph():
    with tempfile.TemporaryDirectory() as tmp:
        result = compile_workflows(
            fail_fast=True,
            write_artifacts=False,
            output_dir=Path(tmp),
        )
        inject_compiled_graph(result.graph)
        install_runtime_validation_hooks()
        yield result.graph
        register_validate_workflow_call_hook(None)


def test_inject_compiled_graph_loads_memory(compiled_graph):
    assert get_compiled_workflow_graph() is compiled_graph
    assert PRODUCT_SEARCH_WORKFLOW in compiled_graph["entry_points"]


def test_assert_runtime_compliance_accepts_entry(compiled_graph):
    node = resolve_turn_entry_node(PRODUCT_SEARCH_WORKFLOW)
    assert_runtime_compliance(PRODUCT_SEARCH_WORKFLOW, node)


def test_assert_runtime_compliance_rejects_unknown_entry(compiled_graph):
    with pytest.raises(WorkflowCompileRuntimeViolation):
        assert_runtime_compliance(PRODUCT_SEARCH_WORKFLOW, "title_catalog_hunt")


def test_runtime_hook_blocks_forbidden_call(compiled_graph):
    with workflow_execution(PRODUCT_SEARCH_WORKFLOW):
        with pytest.raises(WorkflowViolationError):
            validate_workflow_call(PRODUCT_SEARCH_WORKFLOW, "_catalog_search")


def test_runtime_hook_allows_allowlisted_call(compiled_graph):
    with workflow_execution(PRODUCT_SEARCH_WORKFLOW):
        validate_workflow_call(PRODUCT_SEARCH_WORKFLOW, "match_product")


def test_resolve_turn_entry_support(compiled_graph):
    assert (
        resolve_turn_entry_node(SUPPORT_HANDOFF_WORKFLOW)
        == "execute_support_handoff_workflow"
    )


def test_handle_turn_stops_on_compile_runtime_violation():
    import asyncio
    import os

    os.environ.setdefault("OPENAI_API_KEY", "test-key")

    from app.runtime.voice_commerce_runtime import VoiceCommerceRuntime
    from app.state.models import SessionState

    session = SessionState(
        session_id="s",
        call_sid="CA_COMPILE",
        from_number="+1",
        to_number="+2",
    )

    runtime = VoiceCommerceRuntime()
    send_calls: list[dict] = []

    async def send(msg: dict):
        send_calls.append(msg)

    with patch(
        "app.agent_runtime.workflow_isolation.isolate_workflow_buffers",
        return_value=PRODUCT_SEARCH_WORKFLOW,
    ):
        with patch(
            "app.agent_runtime.workflow_compiler.assert_runtime_compliance",
            side_effect=WorkflowCompileRuntimeViolation(
                domain=PRODUCT_SEARCH_WORKFLOW,
                node="bad",
                reason="test",
            ),
        ):
            result = asyncio.run(runtime.handle_turn(session, "find a book", send))

    assert result.response_text
    assert send_calls
