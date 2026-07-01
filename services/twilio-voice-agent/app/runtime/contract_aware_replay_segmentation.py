"""
ContractAwareReplaySegmentation — per-era replay reporting.

Segments session replay by execution-contract eras and maps contract drift to
behavioral divergence. Does not modify execution logic or replay correctness.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Optional

from .execution_contract_versioning import (
    ContractTurnDrift,
    ExecutionContractVersion,
    compare_execution_contracts,
    resolve_recorded_contract,
)

if TYPE_CHECKING:
    from .conversation_replay_engine import (
        ConversationReplayEngine,
        ConversationReplayResult,
        DeterminismReport,
        ReplayTurnResult,
    )
    from .conversation_replay_tape import ConversationReplayTape

CONTRACT_AWARE_REPLAY_SEGMENTATION_VERSION = "v1.0"

_FIELD_TO_SUBSYSTEM: dict[str, str] = {
    "fsm_version": "fsm",
    "policy_version": "policy",
    "intent_schema_version": "intent_schema",
    "graph_schema_version": "graph_schema",
}


@dataclass(frozen=True)
class ContractSegment:
    """Contiguous turn range sharing one recorded execution contract."""

    start_turn_index: int
    end_turn_index: int
    execution_contract: ExecutionContractVersion
    behavioral_determinism_result: "DeterminismReport"
    segment_index: int = 0

    @property
    def turn_count(self) -> int:
        return self.end_turn_index - self.start_turn_index + 1


@dataclass(frozen=True)
class SegmentedReplayResult:
    session_id: str
    replay_result: "ConversationReplayResult"
    segments: tuple[ContractSegment, ...] = ()


@dataclass(frozen=True)
class ContractBehaviorMapping:
    """Contract drift vs behavioral mismatch on the same turn."""

    turn_index: int
    version_drift: bool
    behavioral_mismatch: bool
    changed_subsystems: tuple[str, ...] = ()


@dataclass(frozen=True)
class SubsystemBehaviorImpact:
    """Subsystem version change correlated with behavioral divergence."""

    subsystem: str
    contract_field: str
    segment_index: int
    boundary_turn_index: int
    recorded_version: str
    next_version: str
    behavioral_divergence_at_boundary: bool
    affected_turn_indices: tuple[int, ...] = ()


@dataclass(frozen=True)
class ContractEvolutionReport:
    session_id: str
    segments: tuple[ContractSegment, ...]
    subsystem_impacts: tuple[SubsystemBehaviorImpact, ...]
    contract_drift_vs_behavior_map: tuple[ContractBehaviorMapping, ...]
    behavioral_timeline: tuple[tuple[int, bool], ...] = ()

    @property
    def era_count(self) -> int:
        return len(self.segments)


def _contracts_equal(
    left: ExecutionContractVersion,
    right: ExecutionContractVersion,
) -> bool:
    return left.to_dict() == right.to_dict()


def _subsystem_for_field(field: str) -> str:
    return _FIELD_TO_SUBSYSTEM.get(field, field)


def _changed_subsystems(
    previous: ExecutionContractVersion,
    current: ExecutionContractVersion,
) -> tuple[str, ...]:
    report = compare_execution_contracts(previous, current)
    return tuple(_subsystem_for_field(m.field) for m in report.mismatches)


def _build_segment_determinism_report(
    session_id: str,
    turn_results: tuple["ReplayTurnResult", ...],
) -> "DeterminismReport":
    from .conversation_replay_engine import DeterminismReport

    mismatches = tuple(
        mismatch
        for result in turn_results
        for mismatch in result.mismatches
    )
    contract_drifts = tuple(
        ContractTurnDrift(
            turn_index=result.turn_index,
            turn_id=result.turn_id,
            report=result.contract_report,
        )
        for result in turn_results
        if result.version_drift
    )
    return DeterminismReport(
        session_id=session_id,
        behavioral_determinism=not mismatches,
        contract_compatibility=not contract_drifts,
        turn_count=len(turn_results),
        behavioral_mismatch_count=len(mismatches),
        contract_drift_count=len(contract_drifts),
        mismatches=mismatches,
        contract_drifts=contract_drifts,
        turn_results=turn_results,
    )


def build_contract_segments(
    session_id: str,
    replay_result: "ConversationReplayResult",
    tape: "ConversationReplayTape",
) -> tuple[ContractSegment, ...]:
    """
    Split replay into contract-version eras using recorded per-turn contracts.

    Read-only — uses existing replay results without re-running turns.
    """
    if not tape.turns:
        return ()

    turn_results_by_index = {
        result.turn_index: result for result in replay_result.turn_results
    }

    segments: list[ContractSegment] = []
    current_contract: Optional[ExecutionContractVersion] = None
    current_indices: list[int] = []

    def flush(segment_index: int) -> None:
        if not current_indices or current_contract is None:
            return
        subset = tuple(
            turn_results_by_index[index]
            for index in current_indices
            if index in turn_results_by_index
        )
        segments.append(
            ContractSegment(
                segment_index=segment_index,
                start_turn_index=current_indices[0],
                end_turn_index=current_indices[-1],
                execution_contract=current_contract,
                behavioral_determinism_result=_build_segment_determinism_report(
                    session_id, subset,
                ),
            ),
        )

    for index, record in enumerate(tape.turns):
        contract = resolve_recorded_contract(record, tape)
        if current_contract is None:
            current_contract = contract
            current_indices = [index]
        elif _contracts_equal(contract, current_contract):
            current_indices.append(index)
        else:
            flush(len(segments))
            current_contract = contract
            current_indices = [index]

    flush(len(segments))
    return tuple(segments)


def build_contract_drift_behavior_map(
    replay_result: "ConversationReplayResult",
    tape: "ConversationReplayTape",
) -> tuple[ContractBehaviorMapping, ...]:
    """Map each turn's contract drift to behavioral mismatch presence."""
    mappings: list[ContractBehaviorMapping] = []
    behavioral_turns = {
        result.turn_index
        for result in replay_result.turn_results
        if result.has_mismatch
    }

    previous_contract: Optional[ExecutionContractVersion] = None
    for index, record in enumerate(tape.turns):
        contract = resolve_recorded_contract(record, tape)
        version_drift = False
        changed: tuple[str, ...] = ()
        if previous_contract is not None and not _contracts_equal(
            previous_contract, contract,
        ):
            version_drift = True
            changed = _changed_subsystems(previous_contract, contract)
        previous_contract = contract
        mappings.append(
            ContractBehaviorMapping(
                turn_index=index,
                version_drift=version_drift,
                behavioral_mismatch=index in behavioral_turns,
                changed_subsystems=changed,
            ),
        )
    return tuple(mappings)


def build_subsystem_impacts(
    segments: tuple[ContractSegment, ...],
    replay_result: "ConversationReplayResult",
) -> tuple[SubsystemBehaviorImpact, ...]:
    """Identify which subsystem version changes correlate with behavioral divergence."""
    if len(segments) < 2:
        return ()

    behavioral_turns = {
        result.turn_index
        for result in replay_result.turn_results
        if result.has_mismatch
    }
    impacts: list[SubsystemBehaviorImpact] = []

    for segment_index in range(1, len(segments)):
        previous = segments[segment_index - 1]
        current = segments[segment_index]
        boundary_turn = current.start_turn_index
        report = compare_execution_contracts(
            previous.execution_contract,
            current.execution_contract,
        )
        if not report.mismatches:
            continue

        window = {boundary_turn, boundary_turn - 1, boundary_turn + 1}
        affected = tuple(
            sorted(turn for turn in behavioral_turns if turn in window)
        )
        divergence_at_boundary = bool(affected)

        for mismatch in report.mismatches:
            segment_turns = range(
                current.start_turn_index,
                current.end_turn_index + 1,
            )
            era_affected = tuple(
                sorted(turn for turn in behavioral_turns if turn in segment_turns)
            )
            impacts.append(
                SubsystemBehaviorImpact(
                    subsystem=_subsystem_for_field(mismatch.field),
                    contract_field=mismatch.field,
                    segment_index=segment_index,
                    boundary_turn_index=boundary_turn,
                    recorded_version=mismatch.recorded,
                    next_version=mismatch.current,
                    behavioral_divergence_at_boundary=divergence_at_boundary,
                    affected_turn_indices=era_affected,
                ),
            )

    return tuple(impacts)


def build_behavioral_timeline(
    segments: tuple[ContractSegment, ...],
) -> tuple[tuple[int, bool], ...]:
    """Per-turn behavioral determinism within each contract era."""
    timeline: list[tuple[int, bool]] = []
    for segment in segments:
        mismatched_turns = {
            result.turn_index
            for result in segment.behavioral_determinism_result.turn_results
            if result.has_mismatch
        }
        for turn_index in range(segment.start_turn_index, segment.end_turn_index + 1):
            timeline.append((turn_index, turn_index not in mismatched_turns))
    return tuple(timeline)


def analyze_contract_evolution_impact_from_segmented(
    segmented: SegmentedReplayResult,
    tape: "ConversationReplayTape",
) -> ContractEvolutionReport:
    """Build evolution report from an already-segmented replay."""
    drift_map = build_contract_drift_behavior_map(
        segmented.replay_result, tape,
    )
    subsystem_impacts = build_subsystem_impacts(
        segmented.segments, segmented.replay_result,
    )
    timeline = build_behavioral_timeline(segmented.segments)
    return ContractEvolutionReport(
        session_id=segmented.session_id,
        segments=segmented.segments,
        subsystem_impacts=subsystem_impacts,
        contract_drift_vs_behavior_map=drift_map,
        behavioral_timeline=timeline,
    )


def analyze_contract_evolution_impact(
    session_id: str,
    *,
    engine: Optional["ConversationReplayEngine"] = None,
) -> ContractEvolutionReport:
    """
    Segment replay by contract era and map drift to behavioral divergence.

    No execution logic changes — reporting only.
    """
    from .conversation_replay_engine import ConversationReplayEngine

    replay_engine = engine or ConversationReplayEngine()
    segmented = replay_engine.replay_session_segmented(session_id)
    tape = replay_engine._load_tape(session_id)
    return analyze_contract_evolution_impact_from_segmented(segmented, tape)


def log_contract_evolution_report(report: ContractEvolutionReport) -> None:
    """Emit one observability line for contract-era analysis."""
    import logging

    logging.getLogger(__name__).info(
        "contract_evolution_report session_id=%s eras=%s impacts=%s "
        "drift_behavior_mappings=%s",
        report.session_id,
        report.era_count,
        len(report.subsystem_impacts),
        len(report.contract_drift_vs_behavior_map),
    )
