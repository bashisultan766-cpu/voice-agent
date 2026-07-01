"""
ExecutionContractVersioningLayer — version metadata for replay compatibility.

Attaches contract snapshots to observability artifacts. Does not modify FSMs,
ExecutionPolicyResolver, IntentCommitmentLayer, or routing behavior.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field, fields
from typing import Any, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from .conversation_replay_tape import ConversationReplayTape, TurnObservabilityRecord

EXECUTION_CONTRACT_VERSIONING_LAYER_VERSION = "v1.0"

_CONTRACT_FIELDS = (
    "fsm_version",
    "policy_version",
    "intent_schema_version",
    "graph_schema_version",
)


@dataclass(frozen=True)
class ExecutionContractVersion:
    """Snapshot of execution-layer schema versions at record or replay time."""

    fsm_version: str = ""
    policy_version: str = ""
    intent_schema_version: str = ""
    graph_schema_version: str = ""

    def to_dict(self) -> dict[str, str]:
        return asdict(self)


@dataclass(frozen=True)
class ContractFieldMismatch:
    field: str
    recorded: str
    current: str


@dataclass(frozen=True)
class ContractMismatchReport:
    compatible: bool
    recorded: ExecutionContractVersion
    current: ExecutionContractVersion
    mismatches: tuple[ContractFieldMismatch, ...] = ()

    @property
    def has_version_drift(self) -> bool:
        return not self.compatible


@dataclass(frozen=True)
class ContractTurnDrift:
    turn_index: int
    turn_id: str
    report: ContractMismatchReport


def current_execution_contract() -> ExecutionContractVersion:
    """Read-only snapshot of live execution contract versions."""
    from ..agent_runtime.workflow_isolation import (
        PRODUCT_COMMERCE_FSM_VERSION,
        WORKFLOW_ISOLATION_VERSION,
    )
    from .conversation_state_graph import CONVERSATION_STATE_GRAPH_VERSION
    from .execution_policy_resolver import EXECUTION_POLICY_VERSION
    from .voice_commerce_runtime import INTENT_COMMITMENT_VERSION

    return ExecutionContractVersion(
        fsm_version=f"{WORKFLOW_ISOLATION_VERSION}+{PRODUCT_COMMERCE_FSM_VERSION}",
        policy_version=EXECUTION_POLICY_VERSION,
        intent_schema_version=INTENT_COMMITMENT_VERSION,
        graph_schema_version=CONVERSATION_STATE_GRAPH_VERSION,
    )


def contract_from_dict(data: Optional[dict[str, Any]]) -> ExecutionContractVersion:
    if not data:
        return ExecutionContractVersion()
    known = {f.name for f in fields(ExecutionContractVersion)}
    return ExecutionContractVersion(
        **{k: str(v or "") for k, v in data.items() if k in known},
    )


def contract_to_dict(contract: ExecutionContractVersion) -> dict[str, str]:
    return contract.to_dict()


def compare_execution_contracts(
    recorded: ExecutionContractVersion,
    current: ExecutionContractVersion,
) -> ContractMismatchReport:
    """
    Compare two execution contracts — metadata only, no routing side effects.
    """
    mismatches: list[ContractFieldMismatch] = []
    for name in _CONTRACT_FIELDS:
        old_val = str(getattr(recorded, name, "") or "")
        new_val = str(getattr(current, name, "") or "")
        if old_val != new_val:
            mismatches.append(
                ContractFieldMismatch(field=name, recorded=old_val, current=new_val),
            )
    return ContractMismatchReport(
        compatible=not mismatches,
        recorded=recorded,
        current=current,
        mismatches=tuple(mismatches),
    )


def legacy_contract_from_graph_dict(graph_dict: dict[str, Any]) -> ExecutionContractVersion:
    """Best-effort contract for tapes recorded before versioning was attached."""
    nested = contract_from_dict(graph_dict.get("execution_contract"))
    if any(getattr(nested, name) for name in _CONTRACT_FIELDS):
        return nested
    return ExecutionContractVersion(
        graph_schema_version=str(graph_dict.get("version", "") or ""),
    )


def resolve_recorded_contract(
    record: "TurnObservabilityRecord",
    tape: Optional["ConversationReplayTape"] = None,
) -> ExecutionContractVersion:
    """Resolve the contract stamped at record time (with legacy fallbacks)."""
    record_contract = getattr(record, "execution_contract", None)
    if record_contract:
        return contract_from_dict(record_contract)

    if tape is not None:
        tape_contract = getattr(tape, "execution_contract", None)
        if tape_contract:
            return contract_from_dict(tape_contract)

    return legacy_contract_from_graph_dict(record.state_graph or {})
