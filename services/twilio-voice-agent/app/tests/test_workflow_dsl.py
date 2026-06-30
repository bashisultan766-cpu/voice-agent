"""Declarative workflow DSL — graph structure and compiler validation."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.agent_os.dsl.workflow_dsl import (
    HANDLER_REGISTRY,
    WORKFLOW_DSL_VERSION,
    WORKFLOW_REGISTRY,
    WorkflowDslError,
    export_workflow_dsl,
    list_workflows,
    load_workflow,
    validate_workflow_dsl,
)


def test_list_workflows_includes_canonical_three():
    names = list_workflows()
    assert "product_search_workflow" in names
    assert "support_handoff_workflow" in names
    assert "order_workflow" in names


def test_load_product_search_workflow():
    wf = load_workflow("product_search_workflow")
    assert wf.entry == "execute_product_search_workflow"
    clarification = wf.get_state("clarification")
    assert clarification is not None
    assert clarification.handler == "product_clarification_turn"
    assert "isbn_search" not in clarification.allowed_next
    assert "match_resolution" in clarification.allowed_next


def test_validate_all_workflows_passes_compiler_checks():
    violations = validate_workflow_dsl()
    assert violations == [], violations


def test_export_writes_workflow_dsl_json(tmp_path: Path):
    out = tmp_path / "workflow_dsl.json"
    path = export_workflow_dsl(out, validate=True)
    assert path.is_file()
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["version"] == WORKFLOW_DSL_VERSION
    assert "product_search_workflow" in payload["workflows"]
    assert payload["workflows"]["product_search_workflow"]["entry"] == (
        "execute_product_search_workflow"
    )
    assert "match_product" in HANDLER_REGISTRY


def test_unknown_workflow_raises():
    with pytest.raises(KeyError):
        load_workflow("nonexistent_workflow", validate=False)


def test_invalid_handler_fails_validation():
    from app.agent_os.dsl.workflow_dsl import (
        ORDER_WORKFLOW_DSL,
        WorkflowDefinition,
        WorkflowState,
    )

    broken = WorkflowDefinition(
        name=ORDER_WORKFLOW_DSL.name,
        entry=ORDER_WORKFLOW_DSL.entry,
        states=(
            WorkflowState(
                name="bad",
                handler="totally_fake_handler",
                allowed_next=("success",),
            ),
        ),
    )
    violations = validate_workflow_dsl(broken)
    assert any(v["code"] == "dsl_unknown_handler" for v in violations)


def test_handlers_map_to_compiler_modules():
    from app.agent_runtime.workflow_compiler import WORKFLOW_SCAN_MODULES

    modules = set(WORKFLOW_SCAN_MODULES)
    modules.add("app.runtime.voice_commerce_runtime")
    for handler, module in HANDLER_REGISTRY.items():
        assert module in modules, f"{handler} -> {module} not in compiler scan set"
