"""Compile-time workflow graph validation."""
from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from app.agent_runtime.workflow_compiler import (
    WORKFLOW_COMPILER_VERSION,
    WorkflowCompileError,
    compile_workflows,
)


def test_compile_workflows_passes_on_current_codebase():
    with tempfile.TemporaryDirectory() as tmp:
        result = compile_workflows(
            fail_fast=True,
            write_artifacts=True,
            output_dir=Path(tmp),
        )
        assert result.ok
        assert result.violations == []
        graph_path = Path(tmp) / "workflow_graph.json"
        report_path = Path(tmp) / "validation_report.json"
        assert graph_path.is_file()
        assert report_path.is_file()
        graph = json.loads(graph_path.read_text(encoding="utf-8"))
        report = json.loads(report_path.read_text(encoding="utf-8"))
        assert graph["version"] == WORKFLOW_COMPILER_VERSION
        assert report["ok"] is True
        assert graph["guarded_functions"]
        assert len(graph["workflows"]) >= 3


def test_entry_guard_violations_detect_duplicates():
    from app.agent_runtime.workflow_compiler import FunctionNode, _entry_guard_violations

    modules = {
        "app.agent_runtime.voice_workflows": {
            "a": FunctionNode(
                module="app.agent_runtime.voice_workflows",
                name="execute_product_search_workflow",
                domain="product_search_workflow",
                guard_kind="workflow_entry_guard",
            ),
            "b": FunctionNode(
                module="app.agent_runtime.voice_workflows",
                name="duplicate_entry",
                domain="product_search_workflow",
                guard_kind="workflow_entry_guard",
            ),
        },
    }
    violations = _entry_guard_violations(modules)
    assert any(v["code"] == "duplicate_entry_guard" for v in violations)


def test_compile_detects_forbidden_call_in_graph(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from app.agent_runtime import workflow_compiler as wc

    def fake_expand(domain, entry, modules, symbol_index):
        return {"domain": domain, "entry": "x", "edges": [], "nodes": []}, [{
            "code": "forbidden_call",
            "domain": domain,
            "chain": "entry -> search_products",
            "message": "test",
        }]

    monkeypatch.setattr(wc, "_expand_graph", fake_expand)

    with pytest.raises(WorkflowCompileError) as exc:
        compile_workflows(
            fail_fast=True,
            write_artifacts=False,
            output_dir=tmp_path,
        )
    assert any(v["code"] == "forbidden_call" for v in exc.value.violations)
