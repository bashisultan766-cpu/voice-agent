"""
Declarative Workflow DSL — graph structure wrapping existing workflow executors.

No business logic lives here. Definitions map 1:1 to Python handlers already
used by voice_workflows, product_resolution, not_found_escalation_flow, and
order_flow_state. Validated against workflow_compiler at export/load time.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TypedDict

logger = logging.getLogger(__name__)

WORKFLOW_DSL_VERSION = "v1.0"

_DSL_DIR = Path(__file__).resolve().parent
_DEFAULT_EXPORT_PATH = _DSL_DIR / "workflow_dsl.json"

# Terminal transition tokens (not executable states).
SPECIAL_TRANSITIONS: frozenset[str] = frozenset({
    "success",
    "fallback",
    "loop_terminal",
    "exit",
})

# handler symbol -> defining module (must exist in workflow_compiler scan graph).
HANDLER_REGISTRY: dict[str, str] = {
    # product_search_workflow
    "execute_product_search_workflow": "app.agent_runtime.voice_workflows",
    "try_product_search_fallback_escalation": "app.agent_runtime.not_found_escalation_flow",
    "try_isbn_short_circuit": "app.agent_runtime.isbn_short_circuit",
    "try_title_catalog_short_circuit": "app.agent_runtime.isbn_short_circuit",
    "isbn_partial_reply": "app.agent_runtime.isbn_short_circuit",
    "match_product": "app.agent_runtime.product_resolution",
    "similarity_engine": "app.agent_runtime.product_resolution",
    "format_exact_match_reply": "app.agent_runtime.product_resolution",
    "format_no_exact_reply": "app.agent_runtime.product_resolution",
    "product_resolution_to_short_circuit": "app.agent_runtime.product_resolution",
    "support_handoff_preparation": "app.agent_runtime.not_found_escalation_flow",
    # support_handoff_workflow
    "execute_support_handoff_workflow": "app.agent_runtime.voice_workflows",
    "process_not_found_escalation_turn": "app.agent_runtime.not_found_escalation_flow",
    "_process_silent_support_handoff_turn": "app.agent_runtime.not_found_escalation_flow",
    "_validate_support_email": "app.agent_runtime.not_found_escalation_flow",
    "_sync_support_handoff_contact": "app.agent_runtime.not_found_escalation_flow",
    "_finalize_handoff_send": "app.agent_runtime.not_found_escalation_flow",
    "analyze_conversation_for_support": "app.escalation.conversation_summarizer",
    "send_support_handoff": "app.escalation.support_handoff",
    # order_workflow
    "try_order_enrichment_short_circuit": "app.agent_runtime.order_flow_state",
    "try_order_collection_short_circuit": "app.agent_runtime.order_flow_state",
    "process_order_turn": "app.agent_runtime.order_flow_state",
    # runtime wrappers (orchestration only — delegates to executors above)
    "product_clarification_turn": "app.runtime.voice_commerce_runtime",
}


class WorkflowStateDict(TypedDict, total=False):
    name: str
    handler: str
    allowed_next: list[str]
    exit_to: str


class WorkflowDict(TypedDict, total=False):
    name: str
    entry: str
    alternate_entries: list[str]
    states: list[WorkflowStateDict]
    version: str


@dataclass(frozen=True)
class WorkflowState:
    name: str
    handler: str
    allowed_next: tuple[str, ...] = ()
    exit_to: str = ""

    def to_dict(self) -> WorkflowStateDict:
        out: WorkflowStateDict = {
            "name": self.name,
            "handler": self.handler,
            "allowed_next": list(self.allowed_next),
        }
        if self.exit_to:
            out["exit_to"] = self.exit_to
        return out


@dataclass(frozen=True)
class WorkflowDefinition:
    name: str
    entry: str
    states: tuple[WorkflowState, ...]
    alternate_entries: tuple[str, ...] = ()

    def to_dict(self) -> WorkflowDict:
        return {
            "name": self.name,
            "entry": self.entry,
            "alternate_entries": list(self.alternate_entries),
            "version": WORKFLOW_DSL_VERSION,
            "states": [s.to_dict() for s in self.states],
        }

    def state_names(self) -> frozenset[str]:
        return frozenset(s.name for s in self.states)

    def get_state(self, name: str) -> WorkflowState | None:
        for state in self.states:
            if state.name == name:
                return state
        return None


# Declarative graphs — structure + transitions only.
PRODUCT_SEARCH_WORKFLOW_DSL = WorkflowDefinition(
    name="product_search_workflow",
    entry="execute_product_search_workflow",
    states=(
        WorkflowState(
            name="clarification",
            handler="product_clarification_turn",
            allowed_next=("match_resolution", "clarification"),
        ),
        WorkflowState(
            name="match_resolution",
            handler="match_product",
            allowed_next=("exact_match", "similarity_fallback", "handoff_staged"),
        ),
        WorkflowState(
            name="similarity_fallback",
            handler="similarity_engine",
            allowed_next=("no_exact_match", "handoff_staged"),
        ),
        WorkflowState(
            name="exact_match",
            handler="format_exact_match_reply",
            allowed_next=("success",),
        ),
        WorkflowState(
            name="no_exact_match",
            handler="format_no_exact_reply",
            allowed_next=("handoff_staged", "similarity_fallback"),
        ),
        WorkflowState(
            name="handoff_staged",
            handler="support_handoff_preparation",
            allowed_next=("exit",),
            exit_to="support_handoff_workflow",
        ),
    ),
)

SUPPORT_HANDOFF_WORKFLOW_DSL = WorkflowDefinition(
    name="support_handoff_workflow",
    entry="execute_support_handoff_workflow",
    states=(
        WorkflowState(
            name="process_turn",
            handler="process_not_found_escalation_turn",
            allowed_next=("awaiting_email", "awaiting_name", "awaiting_finalize", "loop_terminal"),
        ),
        WorkflowState(
            name="awaiting_email",
            handler="_process_silent_support_handoff_turn",
            allowed_next=("email_validation", "awaiting_name", "awaiting_finalize", "loop_terminal"),
        ),
        WorkflowState(
            name="email_validation",
            handler="_validate_support_email",
            allowed_next=("awaiting_name", "awaiting_finalize", "awaiting_email"),
        ),
        WorkflowState(
            name="awaiting_name",
            handler="_sync_support_handoff_contact",
            allowed_next=("awaiting_email", "awaiting_finalize"),
        ),
        WorkflowState(
            name="awaiting_finalize",
            handler="_finalize_handoff_send",
            allowed_next=("analyze", "success"),
        ),
        WorkflowState(
            name="analyze",
            handler="analyze_conversation_for_support",
            allowed_next=("send",),
        ),
        WorkflowState(
            name="send",
            handler="send_support_handoff",
            allowed_next=("success",),
        ),
        WorkflowState(
            name="loop_terminal",
            handler="process_not_found_escalation_turn",
            allowed_next=("exit",),
        ),
    ),
)

ORDER_WORKFLOW_DSL = WorkflowDefinition(
    name="order_workflow",
    entry="try_order_enrichment_short_circuit",
    alternate_entries=(
        "process_order_turn",
        "try_order_collection_short_circuit",
    ),
    states=(
        WorkflowState(
            name="awaiting_order_number",
            handler="try_order_collection_short_circuit",
            allowed_next=("order_lookup", "awaiting_order_number"),
        ),
        WorkflowState(
            name="order_lookup",
            handler="try_order_enrichment_short_circuit",
            allowed_next=("success", "fallback", "awaiting_order_number"),
        ),
        WorkflowState(
            name="order_processing",
            handler="process_order_turn",
            allowed_next=("order_lookup", "awaiting_order_number", "success"),
        ),
    ),
)

WORKFLOW_REGISTRY: dict[str, WorkflowDefinition] = {
    PRODUCT_SEARCH_WORKFLOW_DSL.name: PRODUCT_SEARCH_WORKFLOW_DSL,
    SUPPORT_HANDOFF_WORKFLOW_DSL.name: SUPPORT_HANDOFF_WORKFLOW_DSL,
    ORDER_WORKFLOW_DSL.name: ORDER_WORKFLOW_DSL,
}


class WorkflowDslError(ValueError):
    """Raised when DSL validation fails."""


def load_workflow(name: str, *, validate: bool = True) -> WorkflowDefinition:
    """
    Load a declarative workflow graph by canonical name.

    Raises WorkflowDslError when ``validate`` is True and compiler checks fail.
    """
    key = (name or "").strip()
    if key not in WORKFLOW_REGISTRY:
        raise KeyError(f"Unknown workflow DSL: {key}")

    definition = WORKFLOW_REGISTRY[key]
    if validate:
        violations = validate_workflow_dsl(definition)
        if violations:
            raise WorkflowDslError(
                f"DSL validation failed for {key}: {violations[0].get('message', '')}",
            )
    return definition


def list_workflows() -> list[str]:
    return sorted(WORKFLOW_REGISTRY.keys())


def all_workflows_dict() -> dict[str, WorkflowDict]:
    return {name: wf.to_dict() for name, wf in WORKFLOW_REGISTRY.items()}


def validate_workflow_dsl(
    definition: WorkflowDefinition | str | None = None,
) -> list[dict[str, Any]]:
    """
    Validate DSL structure against workflow_compiler contracts.

    Returns a list of violation dicts (empty when valid).
    """
    from app.agent_runtime.workflow_compiler import WORKFLOW_ENTRY_POINTS
    from app.agent_runtime.workflow_contracts import (
        DOMAIN_ALLOWLISTS,
        ORDER_WORKFLOW,
        PRODUCT_SEARCH_WORKFLOW,
        SUPPORT_HANDOFF_WORKFLOW,
    )

    definitions: list[WorkflowDefinition]
    if definition is None:
        definitions = list(WORKFLOW_REGISTRY.values())
    elif isinstance(definition, str):
        definitions = [WORKFLOW_REGISTRY[definition]]
    else:
        definitions = [definition]

    violations: list[dict[str, Any]] = []

    for wf in definitions:
        compiler_entries = {
            fn
            for _mod, fn in WORKFLOW_ENTRY_POINTS.get(wf.name, [])
        }
        all_entries = {wf.entry, *wf.alternate_entries}

        if compiler_entries and not all_entries & compiler_entries:
            violations.append({
                "code": "dsl_entry_mismatch",
                "workflow": wf.name,
                "message": (
                    f"DSL entry {wf.entry!r} does not match compiler entries "
                    f"{sorted(compiler_entries)}"
                ),
            })

        allowlist = DOMAIN_ALLOWLISTS.get(wf.name, frozenset())
        state_names = wf.state_names()

        if not wf.states:
            violations.append({
                "code": "dsl_empty_states",
                "workflow": wf.name,
                "message": f"workflow {wf.name} has no states",
            })
            continue

        for state in wf.states:
            if state.handler not in HANDLER_REGISTRY:
                violations.append({
                    "code": "dsl_unknown_handler",
                    "workflow": wf.name,
                    "state": state.name,
                    "handler": state.handler,
                    "message": f"unknown handler {state.handler!r}",
                })
            elif state.handler in allowlist or state.handler in compiler_entries:
                pass
            elif state.handler in HANDLER_REGISTRY:
                # Orchestrator / short-circuit wrappers are allowed if registered.
                pass
            else:
                violations.append({
                    "code": "dsl_handler_not_in_contract",
                    "workflow": wf.name,
                    "state": state.name,
                    "handler": state.handler,
                    "message": (
                        f"handler {state.handler!r} not in compiler allowlist "
                        f"for {wf.name}"
                    ),
                })

            for nxt in state.allowed_next:
                if nxt in SPECIAL_TRANSITIONS:
                    continue
                if nxt not in state_names:
                    violations.append({
                        "code": "dsl_invalid_transition",
                        "workflow": wf.name,
                        "state": state.name,
                        "transition": nxt,
                        "message": (
                            f"transition {nxt!r} from {state.name!r} "
                            f"is not a defined state or special token"
                        ),
                    })

            if state.exit_to and state.exit_to not in WORKFLOW_REGISTRY:
                violations.append({
                    "code": "dsl_invalid_exit",
                    "workflow": wf.name,
                    "state": state.name,
                    "exit_to": state.exit_to,
                    "message": f"exit_to {state.exit_to!r} is not a known workflow",
                })

        # Cross-check: compiler allowlisted handlers appear in DSL graph.
        if wf.name == PRODUCT_SEARCH_WORKFLOW:
            dsl_handlers = {s.handler for s in wf.states}
            for required in allowlist:
                if required not in dsl_handlers:
                    violations.append({
                        "code": "dsl_missing_allowlisted_handler",
                        "workflow": wf.name,
                        "handler": required,
                        "message": (
                            f"compiler allowlist handler {required!r} "
                            f"missing from DSL graph"
                        ),
                    })
        if wf.name == SUPPORT_HANDOFF_WORKFLOW:
            dsl_handlers = {s.handler for s in wf.states}
            for required in allowlist:
                if required not in dsl_handlers:
                    violations.append({
                        "code": "dsl_missing_allowlisted_handler",
                        "workflow": wf.name,
                        "handler": required,
                        "message": (
                            f"compiler allowlist handler {required!r} "
                            f"missing from DSL graph"
                        ),
                    })

        if wf.name == ORDER_WORKFLOW:
            missing_entries = compiler_entries - all_entries
            if missing_entries:
                violations.append({
                    "code": "dsl_missing_compiler_entry",
                    "workflow": wf.name,
                    "entries": sorted(missing_entries),
                    "message": (
                        f"compiler entry handlers missing from DSL alternate_entries: "
                        f"{sorted(missing_entries)}"
                    ),
                })

    return violations


def export_workflow_dsl(
    output_path: Path | str | None = None,
    *,
    validate: bool = True,
) -> Path:
    """
    Export all workflow DSL definitions to workflow_dsl.json.

    Raises WorkflowDslError when validation fails and ``validate`` is True.
    """
    if validate:
        violations = validate_workflow_dsl()
        if violations:
            for v in violations:
                logger.error(
                    "workflow_dsl_validation code=%s workflow=%s msg=%s",
                    v.get("code"),
                    v.get("workflow"),
                    v.get("message"),
                )
            raise WorkflowDslError(
                f"workflow DSL export blocked: {len(violations)} violation(s)",
            )

    path = Path(output_path) if output_path else _DEFAULT_EXPORT_PATH
    payload = {
        "version": WORKFLOW_DSL_VERSION,
        "workflows": all_workflows_dict(),
        "handler_registry": HANDLER_REGISTRY,
        "special_transitions": sorted(SPECIAL_TRANSITIONS),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    logger.info("workflow_dsl_exported path=%s workflows=%d", path, len(WORKFLOW_REGISTRY))
    return path


def resolve_handler(handler: str) -> tuple[str, str]:
    """Return (module, symbol) for a DSL handler name."""
    module = HANDLER_REGISTRY.get(handler)
    if not module:
        raise KeyError(f"Unknown DSL handler: {handler}")
    return module, handler


def main() -> int:
    """CLI: python -m app.agent_os.dsl.workflow_dsl"""
    import argparse

    logging.basicConfig(level=logging.INFO)
    parser = argparse.ArgumentParser(description="Export and validate workflow DSL")
    parser.add_argument(
        "--output",
        type=Path,
        default=_DEFAULT_EXPORT_PATH,
        help="Path for workflow_dsl.json",
    )
    parser.add_argument(
        "--no-validate",
        action="store_true",
        help="Skip compiler cross-validation",
    )
    args = parser.parse_args()

    try:
        path = export_workflow_dsl(args.output, validate=not args.no_validate)
    except WorkflowDslError:
        return 1

    print(json.dumps({"exported": str(path), "workflows": list_workflows()}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
