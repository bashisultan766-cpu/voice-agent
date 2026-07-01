"""
Compile-time workflow validation — static graph analysis before runtime.

Scans canonical workflow entry points and guarded nodes, builds an execution
graph, and fails fast when contracts are inconsistent or code violates domain
rules (cross-domain jumps, LLM in restricted nodes, duplicate entry guards).
"""
from __future__ import annotations

import ast
import json
import logging
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .workflow_contracts import (
    CANONICAL_WORKFLOW_DOMAINS,
    DOMAIN_ALLOWLISTS,
    FORBIDDEN_IN_PRODUCT_SEARCH,
    FORBIDDEN_IN_SUPPORT_HANDOFF,
    ORDER_WORKFLOW,
    PRODUCT_RESOLUTION_SYMBOLS,
    PRODUCT_SEARCH_ALLOWED,
    PRODUCT_SEARCH_WORKFLOW,
    SUPPORT_HANDOFF_ALLOWED,
    SUPPORT_HANDOFF_WORKFLOW,
    WORKFLOW_CONTRACTS_VERSION,
)

logger = logging.getLogger(__name__)

WORKFLOW_COMPILER_VERSION = "v1.0"

_COMPILER_DIR = Path(__file__).resolve().parent
_APP_DIR = _COMPILER_DIR.parent
_DEFAULT_OUTPUT_DIR = _COMPILER_DIR / "compiled"

# Modules whose call graph is analyzed for workflow edges.
WORKFLOW_SCAN_MODULES: tuple[str, ...] = (
    "app.agent_runtime.voice_workflows",
    "app.agent_runtime.product_resolution",
    "app.agent_runtime.isbn_short_circuit",
    "app.agent_runtime.not_found_escalation_flow",
    "app.agent_runtime.order_flow_state",
    "app.escalation.conversation_summarizer",
    "app.escalation.support_handoff",
)

# Canonical entry points per domain (module, function).
WORKFLOW_ENTRY_POINTS: dict[str, list[tuple[str, str]]] = {
    PRODUCT_SEARCH_WORKFLOW: [
        ("app.agent_runtime.voice_workflows", "execute_product_search_workflow"),
    ],
    SUPPORT_HANDOFF_WORKFLOW: [
        ("app.agent_runtime.voice_workflows", "execute_support_handoff_workflow"),
    ],
    ORDER_WORKFLOW: [
        ("app.agent_runtime.order_flow_state", "try_order_enrichment_short_circuit"),
        ("app.agent_runtime.order_flow_state", "process_order_turn"),
        ("app.agent_runtime.order_flow_state", "try_order_collection_short_circuit"),
    ],
}

# Allowed LLM symbols per domain (summarization only in support).
LLM_ALLOWED_BY_DOMAIN: dict[str, frozenset[str]] = {
    PRODUCT_SEARCH_WORKFLOW: frozenset(),
    ORDER_WORKFLOW: frozenset(),
    SUPPORT_HANDOFF_WORKFLOW: frozenset({"analyze_conversation_for_support"}),
}

# AST patterns that indicate LLM / brain routing (not allowed in product/order nodes).
LLM_FORBIDDEN_CALL_MARKERS: frozenset[str] = frozenset({
    "chat.completions",
    "completions.create",
    "AsyncOpenAI",
    "OpenAI",
    "run_turn",
    "MainCommerceBrain",
    "_run_brain",
    "dispatch",
})

# Calls allowed only inside specific parent nodes (mirrors runtime depth guards).
NESTED_ALLOWED_CALLS: dict[str, frozenset[str]] = {
    "match_product": frozenset({"_catalog_search", "search_product_by_isbn"}),
}
# Cross-domain staging: product may call these support-prefixed symbols intentionally.
CROSS_DOMAIN_ALLOWED_CALLS: frozenset[str] = frozenset({
    "support_handoff_preparation",
    "try_product_search_fallback_escalation",
    "send_support_handoff",
    "maybe_execute_escalation",
    "process_not_found_escalation_turn",
})


class WorkflowCompileError(RuntimeError):
    """Raised when compile-time workflow validation fails."""

    def __init__(self, violations: list[dict[str, Any]]):
        self.violations = violations
        chain = " -> ".join(
            v.get("chain", v.get("code", "")) for v in violations[:5]
        )
        super().__init__(
            f"Workflow compile failed ({len(violations)} violation(s)): {chain}",
        )


@dataclass
class FunctionNode:
    module: str
    name: str
    domain: str | None = None
    guard_kind: str = ""  # workflow_guard | workflow_entry_guard | ""
    calls: set[str] = field(default_factory=set)
    llm_markers: set[str] = field(default_factory=set)
    source_file: str = ""
    lineno: int = 0


@dataclass
class CompileResult:
    ok: bool
    violations: list[dict[str, Any]]
    graph: dict[str, Any]
    report: dict[str, Any]
    output_dir: Path


def _module_to_path(module: str) -> Path:
    rel = module.removeprefix("app.").replace(".", "/") + ".py"
    return _APP_DIR / rel


def _decorator_info(node: ast.AST) -> tuple[str, str, str] | None:
    if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return None
    for dec in node.decorator_list:
        if not isinstance(dec, ast.Call):
            continue
        func = dec.func
        kind = ""
        if isinstance(func, ast.Name):
            kind = func.id
        elif isinstance(func, ast.Attribute):
            kind = func.attr
        if kind not in ("workflow_guard", "workflow_entry_guard"):
            continue
        domain = ""
        label = node.name
        if dec.args:
            arg0 = dec.args[0]
            if isinstance(arg0, ast.Constant) and isinstance(arg0.value, str):
                domain = arg0.value
        if len(dec.args) > 1:
            arg1 = dec.args[1]
            if isinstance(arg1, ast.Constant) and isinstance(arg1.value, str):
                label = arg1.value
        return kind, domain, label
    return None


def _call_name(node: ast.Call) -> str:
    func = node.func
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        parts: list[str] = []
        cur: ast.AST = func
        while isinstance(cur, ast.Attribute):
            parts.append(cur.attr)
            cur = cur.value
        if isinstance(cur, ast.Name):
            parts.append(cur.id)
        return ".".join(reversed(parts))
    return ""


def _collect_calls_and_llm(body: list[ast.stmt]) -> tuple[set[str], set[str]]:
    calls: set[str] = set()
    llm: set[str] = set()
    for stmt in body:
        for node in ast.walk(stmt):
            if not isinstance(node, ast.Call):
                continue
            name = _call_name(node)
            if name:
                calls.add(name)
                base = name.split(".")[-1]
                calls.add(base)
                for marker in LLM_FORBIDDEN_CALL_MARKERS:
                    if marker in name or marker == base:
                        llm.add(marker)
    return calls, llm


def _parse_module(module: str) -> dict[str, FunctionNode]:
    path = _module_to_path(module)
    source = path.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(path))
    nodes: dict[str, FunctionNode] = {}
    for item in tree.body:
        if not isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        dec = _decorator_info(item)
        domain = None
        guard_kind = ""
        label = item.name
        if dec:
            guard_kind, domain, label = dec
        calls, llm = _collect_calls_and_llm(item.body)
        key = label if dec and dec[2] else item.name
        nodes[item.name] = FunctionNode(
            module=module,
            name=key,
            domain=domain,
            guard_kind=guard_kind,
            calls=calls,
            llm_markers=llm,
            source_file=str(path),
            lineno=item.lineno,
        )
    return nodes


def _build_symbol_index(
    modules: dict[str, dict[str, FunctionNode]],
) -> dict[str, list[FunctionNode]]:
    index: dict[str, list[FunctionNode]] = {}
    for mod_nodes in modules.values():
        for fn in mod_nodes.values():
            index.setdefault(fn.name, []).append(fn)
    return index


def _contract_violations() -> list[dict[str, Any]]:
    violations: list[dict[str, Any]] = []
    overlap = PRODUCT_SEARCH_ALLOWED & FORBIDDEN_IN_PRODUCT_SEARCH
    if overlap:
        violations.append({
            "code": "allowlist_forbidden_overlap",
            "domain": PRODUCT_SEARCH_WORKFLOW,
            "chain": PRODUCT_SEARCH_WORKFLOW,
            "symbols": sorted(overlap),
            "message": "product_search allowlist intersects forbidden set",
        })
    overlap = SUPPORT_HANDOFF_ALLOWED & FORBIDDEN_IN_SUPPORT_HANDOFF
    if overlap:
        violations.append({
            "code": "allowlist_forbidden_overlap",
            "domain": SUPPORT_HANDOFF_WORKFLOW,
            "chain": SUPPORT_HANDOFF_WORKFLOW,
            "symbols": sorted(overlap),
            "message": "support_handoff allowlist intersects forbidden set",
        })
    for domain, allowlist in DOMAIN_ALLOWLISTS.items():
        forbidden = (
            FORBIDDEN_IN_PRODUCT_SEARCH
            if domain == PRODUCT_SEARCH_WORKFLOW
            else FORBIDDEN_IN_SUPPORT_HANDOFF
        )
        for symbol in allowlist:
            if symbol in forbidden:
                violations.append({
                    "code": "allowlist_contains_forbidden",
                    "domain": domain,
                    "chain": f"{domain}::{symbol}",
                    "message": f"{symbol} is both allowed and forbidden",
                })
    return violations


def _entry_guard_violations(
    modules: dict[str, dict[str, FunctionNode]],
) -> list[dict[str, Any]]:
    violations: list[dict[str, Any]] = []
    entry_by_domain: dict[str, list[str]] = {}
    for mod_nodes in modules.values():
        for fn in mod_nodes.values():
            if fn.guard_kind != "workflow_entry_guard" or not fn.domain:
                continue
            entry_by_domain.setdefault(fn.domain, []).append(
                f"{fn.module}::{fn.name}",
            )
    for domain, entries in entry_by_domain.items():
        if len(entries) > 1:
            violations.append({
                "code": "duplicate_entry_guard",
                "domain": domain,
                "chain": " | ".join(entries),
                "entries": entries,
                "message": f"multiple @workflow_entry_guard for {domain}",
            })
    return violations


def _guarded_allowlist_violations(
    modules: dict[str, dict[str, FunctionNode]],
) -> list[dict[str, Any]]:
    violations: list[dict[str, Any]] = []
    for mod_nodes in modules.values():
        for fn in mod_nodes.values():
            if fn.guard_kind != "workflow_guard" or not fn.domain:
                continue
            allowlist = DOMAIN_ALLOWLISTS.get(fn.domain)
            if allowlist is None:
                continue
            if fn.name not in allowlist:
                violations.append({
                    "code": "unguarded_allowlist_mismatch",
                    "domain": fn.domain,
                    "chain": f"{fn.module}::{fn.name}",
                    "message": (
                        f"@workflow_guard function {fn.name} not in allowlist "
                        f"for {fn.domain}"
                    ),
                })
    return violations


def _nested_call_allowed(chain: list[str], callee: str) -> bool:
    """True when callee is permitted inside a parent node (e.g. catalog in match_product)."""
    for parent in reversed(chain):
        base = parent.split(".")[-1]
        allowed = NESTED_ALLOWED_CALLS.get(base)
        if allowed and callee in allowed:
            return True
    return False


def _expand_graph(
    domain: str,
    entry: FunctionNode,
    modules: dict[str, dict[str, FunctionNode]],
    symbol_index: dict[str, list[FunctionNode]],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """BFS from entry; return subgraph edges and violations."""
    violations: list[dict[str, Any]] = []
    edges: list[dict[str, str]] = []
    allowed_next = DOMAIN_ALLOWLISTS.get(domain, frozenset())
    forbidden = (
        FORBIDDEN_IN_PRODUCT_SEARCH
        if domain == PRODUCT_SEARCH_WORKFLOW
        else FORBIDDEN_IN_SUPPORT_HANDOFF
        if domain == SUPPORT_HANDOFF_WORKFLOW
        else PRODUCT_RESOLUTION_SYMBOLS | frozenset({
            "_catalog_search", "_search_products", "search_products",
        })
    )
    llm_allowed = LLM_ALLOWED_BY_DOMAIN.get(domain, frozenset())

    visited: set[str] = set()
    queue: list[tuple[FunctionNode, list[str]]] = [(entry, [f"{entry.module}::{entry.name}"])]

    while queue:
        node, chain = queue.pop(0)
        node_id = f"{node.module}::{node.name}"
        if node_id in visited:
            continue
        visited.add(node_id)

        if node.llm_markers:
            if domain == SUPPORT_HANDOFF_WORKFLOW and node.name in llm_allowed:
                pass
            elif domain in (PRODUCT_SEARCH_WORKFLOW, ORDER_WORKFLOW) or (
                domain == SUPPORT_HANDOFF_WORKFLOW and node.name not in llm_allowed
            ):
                violations.append({
                    "code": "llm_in_restricted_node",
                    "domain": domain,
                    "chain": " -> ".join(chain),
                    "node": node_id,
                    "llm_markers": sorted(node.llm_markers),
                    "message": f"LLM/brain call in restricted workflow node {node.name}",
                })

        for call in sorted(node.calls):
            base = call.split(".")[-1]
            if base in forbidden or call in forbidden:
                if _nested_call_allowed(chain, base):
                    pass
                else:
                    violations.append({
                        "code": "forbidden_call",
                        "domain": domain,
                        "chain": " -> ".join(chain + [base]),
                        "callee": base,
                        "message": f"forbidden callee {base} in {domain}",
                    })
                    continue

            targets = symbol_index.get(base, [])
            for target in targets:
                edge = {"from": node_id, "to": f"{target.module}::{target.name}", "domain": domain}
                edges.append(edge)

                if target.guard_kind and target.domain and target.domain != domain:
                    if base not in CROSS_DOMAIN_ALLOWED_CALLS:
                        violations.append({
                            "code": "cross_domain_jump",
                            "domain": domain,
                            "chain": " -> ".join(chain + [base]),
                            "from_domain": domain,
                            "to_domain": target.domain,
                            "message": (
                                f"cross-domain call {base}: {domain} -> {target.domain}"
                            ),
                        })
                elif (
                    domain in DOMAIN_ALLOWLISTS
                    and target.guard_kind == "workflow_guard"
                    and base not in allowed_next
                    and base not in CROSS_DOMAIN_ALLOWED_CALLS
                ):
                    violations.append({
                        "code": "unguarded_callee_not_in_allowlist",
                        "domain": domain,
                        "chain": " -> ".join(chain + [base]),
                        "callee": base,
                        "message": f"guarded callee {base} not in allowlist for {domain}",
                    })

                if f"{target.module}::{target.name}" not in visited:
                    queue.append((target, chain + [base]))

    return {"domain": domain, "entry": f"{entry.module}::{entry.name}", "edges": edges, "nodes": sorted(visited)}, violations


def _resolve_entry(module: str, name: str, modules: dict[str, dict[str, FunctionNode]]) -> FunctionNode | None:
    mod_nodes = modules.get(module, {})
    if name in mod_nodes:
        return mod_nodes[name]
    for fn in mod_nodes.values():
        if fn.name == name:
            return fn
    return None


def compile_workflows(
    *,
    fail_fast: bool = True,
    write_artifacts: bool = True,
    output_dir: Path | None = None,
) -> CompileResult:
    """
    Compile and validate workflow graphs.

    Raises WorkflowCompileError when ``fail_fast`` is True and violations exist.
    """
    out_dir = output_dir or _DEFAULT_OUTPUT_DIR
    violations: list[dict[str, Any]] = []

    violations.extend(_contract_violations())

    modules: dict[str, dict[str, FunctionNode]] = {}
    for module in WORKFLOW_SCAN_MODULES:
        path = _module_to_path(module)
        if not path.is_file():
            violations.append({
                "code": "missing_scan_module",
                "chain": module,
                "message": f"workflow scan module not found: {path}",
            })
            continue
        modules[module] = _parse_module(module)

    violations.extend(_entry_guard_violations(modules))
    violations.extend(_guarded_allowlist_violations(modules))

    symbol_index = _build_symbol_index(modules)
    subgraphs: list[dict[str, Any]] = []

    for domain in sorted(CANONICAL_WORKFLOW_DOMAINS):
        entries = WORKFLOW_ENTRY_POINTS.get(domain, [])
        if not entries:
            violations.append({
                "code": "missing_entry_point",
                "domain": domain,
                "chain": domain,
                "message": f"no entry points configured for {domain}",
            })
            continue
        for module, func_name in entries:
            entry = _resolve_entry(module, func_name, modules)
            if entry is None:
                violations.append({
                    "code": "missing_entry_function",
                    "domain": domain,
                    "chain": f"{module}::{func_name}",
                    "message": f"entry function not found: {module}.{func_name}",
                })
                continue
            subgraph, sub_violations = _expand_graph(domain, entry, modules, symbol_index)
            subgraphs.append(subgraph)
            violations.extend(sub_violations)

    graph = {
        "version": WORKFLOW_COMPILER_VERSION,
        "contracts_version": WORKFLOW_CONTRACTS_VERSION,
        "compiled_at": datetime.now(timezone.utc).isoformat(),
        "domains": sorted(CANONICAL_WORKFLOW_DOMAINS),
        "scan_modules": list(WORKFLOW_SCAN_MODULES),
        "entry_points": {
            domain: [f"{m}::{f}" for m, f in points]
            for domain, points in WORKFLOW_ENTRY_POINTS.items()
        },
        "allowlists": {k: sorted(v) for k, v in DOMAIN_ALLOWLISTS.items()},
        "forbidden": {
            PRODUCT_SEARCH_WORKFLOW: sorted(FORBIDDEN_IN_PRODUCT_SEARCH),
            SUPPORT_HANDOFF_WORKFLOW: sorted(FORBIDDEN_IN_SUPPORT_HANDOFF),
            ORDER_WORKFLOW: sorted(PRODUCT_RESOLUTION_SYMBOLS),
        },
        "workflows": subgraphs,
        "guarded_functions": [
            {
                "module": fn.module,
                "name": fn.name,
                "domain": fn.domain,
                "guard_kind": fn.guard_kind,
                "file": fn.source_file,
                "line": fn.lineno,
                "allowed_next": sorted(
                    DOMAIN_ALLOWLISTS.get(fn.domain or "", frozenset()),
                ),
                "forbidden_calls": sorted(
                    FORBIDDEN_IN_PRODUCT_SEARCH
                    if fn.domain == PRODUCT_SEARCH_WORKFLOW
                    else FORBIDDEN_IN_SUPPORT_HANDOFF
                    if fn.domain == SUPPORT_HANDOFF_WORKFLOW
                    else PRODUCT_RESOLUTION_SYMBOLS
                ),
            }
            for mod_nodes in modules.values()
            for fn in mod_nodes.values()
            if fn.guard_kind
        ],
    }

    report = {
        "version": WORKFLOW_COMPILER_VERSION,
        "compiled_at": graph["compiled_at"],
        "ok": len(violations) == 0,
        "violation_count": len(violations),
        "violations": violations,
        "summary": {
            "domains_validated": len(CANONICAL_WORKFLOW_DOMAINS),
            "workflow_subgraphs": len(subgraphs),
            "guarded_function_count": len(graph["guarded_functions"]),
            "scan_module_count": len(modules),
        },
    }

    if write_artifacts:
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "workflow_graph.json").write_text(
            json.dumps(graph, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        (out_dir / "validation_report.json").write_text(
            json.dumps(report, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        logger.info(
            "workflow_compile artifacts_written dir=%s ok=%s violations=%d",
            out_dir,
            report["ok"],
            len(violations),
        )

    result = CompileResult(
        ok=report["ok"],
        violations=violations,
        graph=graph,
        report=report,
        output_dir=out_dir,
    )

    if fail_fast and violations:
        _print_compile_errors(violations)
        raise WorkflowCompileError(violations)

    return result


def _print_compile_errors(violations: list[dict[str, Any]]) -> None:
    print("WORKFLOW COMPILE FAILED", file=sys.stderr)
    print(f"violations={len(violations)}", file=sys.stderr)
    for idx, v in enumerate(violations, 1):
        print(
            f"  [{idx}] {v.get('code', 'error')}: {v.get('message', '')}",
            file=sys.stderr,
        )
        if v.get("chain"):
            print(f"       chain: {v['chain']}", file=sys.stderr)
        if v.get("node"):
            print(f"       node: {v['node']}", file=sys.stderr)


# ── Runtime graph memory + compliance hooks ───────────────────────────────────

_RUNTIME_GRAPH: dict[str, Any] | None = None
_RUNTIME_GRAPH_INDEX: dict[str, dict[str, Any]] | None = None
_RUNTIME_HOOKS_INSTALLED = False


class WorkflowCompileRuntimeViolation(RuntimeError):
    """Raised when runtime execution diverges from the compiled workflow graph."""

    def __init__(self, *, domain: str, node: str, reason: str):
        self.domain = domain
        self.node = node
        self.reason = reason
        super().__init__(
            f"Workflow compile runtime violation [{domain}::{node}]: {reason}",
        )


def _node_base(node: str) -> str:
    return (node or "").split("::")[-1].split(".")[-1].strip()


def _build_runtime_graph_index(graph: dict[str, Any]) -> dict[str, dict[str, Any]]:
    index: dict[str, dict[str, Any]] = {}
    for domain in graph.get("domains", []):
        allowlist = set(graph.get("allowlists", {}).get(domain, []))
        forbidden = set(graph.get("forbidden", {}).get(domain, []))
        entries = list(graph.get("entry_points", {}).get(domain, []))
        nodes: set[str] = set()
        for wf in graph.get("workflows", []):
            if wf.get("domain") == domain:
                nodes.update(wf.get("nodes", []))
        index[domain] = {
            "allowlist": allowlist,
            "forbidden": forbidden,
            "entries": entries,
            "nodes": nodes,
            "node_bases": {_node_base(n) for n in nodes},
        }
    return index


def inject_compiled_graph(graph: dict[str, Any]) -> None:
    """Load compiled workflow graph into process memory for runtime checks."""
    global _RUNTIME_GRAPH, _RUNTIME_GRAPH_INDEX
    _RUNTIME_GRAPH = graph
    _RUNTIME_GRAPH_INDEX = _build_runtime_graph_index(graph)
    logger.info(
        "workflow_graph_injected version=%s domains=%d",
        graph.get("version"),
        len(graph.get("domains", [])),
    )


def get_compiled_workflow_graph() -> dict[str, Any] | None:
    return _RUNTIME_GRAPH


def get_runtime_graph_index() -> dict[str, dict[str, Any]] | None:
    return _RUNTIME_GRAPH_INDEX


def _ensure_runtime_graph_loaded() -> None:
    if _RUNTIME_GRAPH is not None:
        return
    artifact = _DEFAULT_OUTPUT_DIR / "workflow_graph.json"
    if not artifact.is_file():
        return
    graph = json.loads(artifact.read_text(encoding="utf-8"))
    inject_compiled_graph(graph)


def _log_compile_runtime_violation(
    *,
    domain: str,
    node: str,
    reason: str,
    phase: str = "turn",
) -> None:
    from ..observability.workflow_events import (
        STEP_WORKFLOW_COMPILE_RUNTIME_VIOLATION,
        emit_event,
    )

    logger.error(
        "workflow_compile_runtime_violation domain=%s node=%s phase=%s reason=%s",
        domain,
        node,
        phase,
        reason,
    )
    emit_event(
        {
            "event_type": "workflow_transition",
            "domain": "unknown",
            "step": STEP_WORKFLOW_COMPILE_RUNTIME_VIOLATION,
            "input_type": "unknown",
            "outcome": "fail",
            "metadata": {
                "workflow_domain": domain,
                "node": node,
                "phase": phase,
                "reason": reason,
            },
        },
    )


def _raise_compile_runtime_violation(
    *,
    domain: str,
    node: str,
    reason: str,
    phase: str = "turn",
) -> None:
    _log_compile_runtime_violation(
        domain=domain,
        node=node,
        reason=reason,
        phase=phase,
    )
    raise WorkflowCompileRuntimeViolation(domain=domain, node=node, reason=reason)


def _assert_graph_call_compliance(domain: str, function_name: str) -> None:
    """Graph-layer check for guarded function calls (hook tail)."""
    if not _RUNTIME_GRAPH_INDEX:
        return
    idx = _RUNTIME_GRAPH_INDEX.get(domain)
    if idx is None:
        return

    base = _node_base(function_name)
    if base in idx["forbidden"]:
        _raise_compile_runtime_violation(
            domain=domain,
            node=base,
            reason="symbol forbidden in compiled graph",
            phase="call",
        )

    allowlist = DOMAIN_ALLOWLISTS.get(domain)
    if allowlist is not None and base not in allowlist:
        if base in idx["node_bases"] or base in CROSS_DOMAIN_ALLOWED_CALLS:
            return
        _raise_compile_runtime_violation(
            domain=domain,
            node=base,
            reason="symbol not in compiled allowlist or graph nodes",
            phase="call",
        )


def _runtime_validate_workflow_call_hook(domain: str, function_name: str) -> None:
    """Runtime hook — contract checks then compiled-graph compliance."""
    from .workflow_contracts import active_workflow_domain, validate_workflow_call_core

    validate_workflow_call_core(domain, function_name)
    if not active_workflow_domain():
        return
    _assert_graph_call_compliance(domain, function_name)


def install_runtime_validation_hooks() -> None:
    """Wire validate_workflow_call() to compiler runtime hook."""
    global _RUNTIME_HOOKS_INSTALLED
    from .workflow_contracts import register_validate_workflow_call_hook

    register_validate_workflow_call_hook(_runtime_validate_workflow_call_hook)
    _RUNTIME_HOOKS_INSTALLED = True
    logger.info("workflow_runtime_hooks_installed")


def resolve_turn_entry_node(domain: str, *, turn_mode: str = "") -> str:
    """Pick the compiled entry symbol for a live turn's active workflow domain."""
    entries = WORKFLOW_ENTRY_POINTS.get(domain, [])
    if not entries:
        return ""
    if domain == ORDER_WORKFLOW:
        mode = (turn_mode or "").strip().lower()
        if mode == "order":
            for _module, name in entries:
                if name == "process_order_turn":
                    return name
        return entries[0][1]
    return entries[0][1]


def assert_runtime_compliance(domain: str, node: str) -> None:
    """
    Turn-boundary compliance — entry node must exist in the compiled graph.

    Raises WorkflowCompileRuntimeViolation on mismatch (stop execution).
    """
    _ensure_runtime_graph_loaded()
    if not domain or domain not in CANONICAL_WORKFLOW_DOMAINS:
        return

    base = _node_base(node)
    if not base:
        _raise_compile_runtime_violation(
            domain=domain,
            node=node,
            reason="empty workflow node",
            phase="turn",
        )

    if not _RUNTIME_GRAPH_INDEX:
        _raise_compile_runtime_violation(
            domain=domain,
            node=base,
            reason="compiled workflow graph not loaded",
            phase="turn",
        )

    idx = _RUNTIME_GRAPH_INDEX.get(domain)
    if idx is None:
        _raise_compile_runtime_violation(
            domain=domain,
            node=base,
            reason=f"domain missing from compiled graph: {domain}",
            phase="turn",
        )

    entry_bases = {_node_base(entry) for entry in idx["entries"]}
    if base not in entry_bases:
        _raise_compile_runtime_violation(
            domain=domain,
            node=base,
            reason="not a compiled workflow entry node",
            phase="turn",
        )

    if base in idx["forbidden"]:
        _raise_compile_runtime_violation(
            domain=domain,
            node=base,
            reason="entry node forbidden in compiled graph",
            phase="turn",
        )


def compile_workflows_at_startup() -> None:
    """Called from application lifespan — fails server boot on violation."""
    result = compile_workflows(fail_fast=True, write_artifacts=True)
    inject_compiled_graph(result.graph)
    install_runtime_validation_hooks()


def main() -> int:
    """CLI entry for deployment validation: python -m app.agent_runtime.workflow_compiler"""
    import argparse

    parser = argparse.ArgumentParser(description="Compile-time workflow validation")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=_DEFAULT_OUTPUT_DIR,
        help="Directory for workflow_graph.json and validation_report.json",
    )
    parser.add_argument(
        "--no-fail",
        action="store_true",
        help="Write artifacts even when violations exist (exit 1)",
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO)
    try:
        result = compile_workflows(
            fail_fast=not args.no_fail,
            write_artifacts=True,
            output_dir=args.output_dir,
        )
    except WorkflowCompileError:
        return 1

    print(json.dumps(result.report["summary"], indent=2))
    return 0 if result.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
