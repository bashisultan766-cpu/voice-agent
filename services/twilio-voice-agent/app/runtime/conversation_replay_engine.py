"""
ConversationReplayEngine — deterministic session replay from observability tapes.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Callable, Optional

from .conversation_replay_codec import (
    classification_from_dict,
    diff_from_dict,
    graph_from_dict,
    session_from_replay_snapshot,
)
from .conversation_replay_tape import (
    ConversationReplayTape,
    TurnObservabilityRecord,
    load_replay_tape,
)
from .conversation_state_graph import ConversationStateGraph, derive_conversation_state_graph
from .conversation_state_graph_diff import (
    ConversationStateGraphDiff,
    diff_conversation_state_graph,
)
from .execution_policy_resolver import (
    build_execution_fsm_state,
    resolve_execution_policy,
)
from .execution_contract_versioning import (
    ContractMismatchReport,
    ContractTurnDrift,
    ExecutionContractVersion,
    compare_execution_contracts,
    current_execution_contract,
    resolve_recorded_contract,
)
from .fast_classifier import ClassificationResult

logger = logging.getLogger(__name__)

CONVERSATION_REPLAY_ENGINE_VERSION = "v1.0"

TapeLoader = Callable[[str], Optional[ConversationReplayTape]]

_GRAPH_COMPARE_EXCLUDE_PATHS = frozenset({
    "email_capture.pending_email_masked",
    "email_capture.confirmed_email_masked",
})


@dataclass(frozen=True)
class ReplayMismatch:
    turn_index: int
    category: str
    field: str
    expected: Any
    actual: Any


@dataclass(frozen=True)
class ReplayTurnResult:
    turn_index: int
    turn_id: str
    reconstructed_graph: ConversationStateGraph
    original_graph: ConversationStateGraph
    reconstructed_diff: Optional[ConversationStateGraphDiff]
    original_diff: Optional[ConversationStateGraphDiff]
    reconstructed_policy: str
    original_policy: str
    classification: ClassificationResult
    recorded_contract: ExecutionContractVersion
    replay_contract: ExecutionContractVersion
    contract_report: ContractMismatchReport
    mismatches: tuple[ReplayMismatch, ...] = ()

    @property
    def has_mismatch(self) -> bool:
        return bool(self.mismatches)

    @property
    def version_drift(self) -> bool:
        return self.contract_report.has_version_drift


@dataclass(frozen=True)
class ConversationReplayResult:
    session_id: str
    turn_results: tuple[ReplayTurnResult, ...]
    mismatches: tuple[ReplayMismatch, ...] = ()
    contract_drifts: tuple[ContractTurnDrift, ...] = ()

    @property
    def deterministic(self) -> bool:
        return not self.mismatches

    @property
    def behavioral_determinism(self) -> bool:
        return not self.mismatches

    @property
    def contract_compatibility(self) -> bool:
        return not self.contract_drifts


@dataclass(frozen=True)
class DeterminismReport:
    session_id: str
    behavioral_determinism: bool
    contract_compatibility: bool
    turn_count: int
    behavioral_mismatch_count: int
    contract_drift_count: int
    mismatches: tuple[ReplayMismatch, ...]
    contract_drifts: tuple[ContractTurnDrift, ...] = ()
    turn_results: tuple[ReplayTurnResult, ...] = ()

    @property
    def deterministic(self) -> bool:
        """Backward-compatible alias — behavioral only, not contract drift."""
        return self.behavioral_determinism

    @property
    def mismatch_count(self) -> int:
        return self.behavioral_mismatch_count


def _graphs_match(
    expected: ConversationStateGraph,
    actual: ConversationStateGraph,
) -> tuple[ReplayMismatch, ...]:
    delta = diff_conversation_state_graph(expected, actual)
    if not delta.has_changes:
        return ()
    mismatches: list[ReplayMismatch] = []
    for path in delta.added_fields:
        if path in _GRAPH_COMPARE_EXCLUDE_PATHS or path.startswith("execution_contract"):
            continue
        mismatches.append(ReplayMismatch(-1, "state_graph", path, "absent", "present"))
    for path in delta.removed_fields:
        if path in _GRAPH_COMPARE_EXCLUDE_PATHS or path.startswith("execution_contract"):
            continue
        mismatches.append(ReplayMismatch(-1, "state_graph", path, "present", "absent"))
    for path, old_val, new_val in delta.changed_fields:
        if path in _GRAPH_COMPARE_EXCLUDE_PATHS or path.startswith("execution_contract"):
            continue
        mismatches.append(ReplayMismatch(-1, "state_graph", path, old_val, new_val))
    for transition in delta.state_transitions:
        mismatches.append(
            ReplayMismatch(
                -1,
                "state_graph",
                f"transition.{transition.domain}.{transition.field}",
                transition.previous,
                transition.current,
            ),
        )
    return tuple(mismatches)


def _diffs_match(
    expected: Optional[ConversationStateGraphDiff],
    actual: Optional[ConversationStateGraphDiff],
) -> tuple[ReplayMismatch, ...]:
    if expected is None and actual is None:
        return ()
    if expected is None or actual is None:
        return (
            ReplayMismatch(
                -1,
                "state_graph_diff",
                "presence",
                expected is not None,
                actual is not None,
            ),
        )
    if expected.to_log_dict() == actual.to_log_dict():
        return ()
    return (
        ReplayMismatch(
            -1,
            "state_graph_diff",
            "bundle",
            expected.to_log_dict(),
            actual.to_log_dict(),
        ),
    )


def _reconstruct_execution_policy(
    session,
    classification: ClassificationResult,
    record: TurnObservabilityRecord,
) -> str:
    fsm = build_execution_fsm_state(
        session,
        turn_mode=record.turn_mode,
        voice_stage=record.voice_stage,
        brain_gate_active=bool(
            graph_from_dict(record.state_graph).execution.brain_gate_active,
        ),
        active_workflow=record.active_workflow,
        workflow_llm_blocked=record.workflow_llm_blocked,
    )
    return resolve_execution_policy(session, classification, fsm)


def _reconstruct_graph(
    session,
    record: TurnObservabilityRecord,
) -> ConversationStateGraph:
    return derive_conversation_state_graph(
        session,
        turn_mode=record.turn_mode,
        caller_text=record.caller_text,
        active_workflow=record.active_workflow,
        execution_policy=record.execution_policy,
        voice_stage=record.voice_stage,
        workflow_llm_blocked=record.workflow_llm_blocked,
    )


class ConversationReplayEngine:
    """
    Replay engine for observability tapes — no live LLM or classify() calls.
    """

    def __init__(self, tape_loader: Optional[TapeLoader] = None) -> None:
        self._tape_loader = tape_loader or load_replay_tape

    def _load_tape(self, session_id: str) -> ConversationReplayTape:
        tape = self._tape_loader(session_id)
        if tape is None or not tape.turns:
            raise ValueError(f"no replay tape for session_id={session_id!r}")
        return tape

    def replay_turn(
        self,
        session_id: str,
        turn_index: int,
        *,
        tape: Optional[ConversationReplayTape] = None,
    ) -> ReplayTurnResult:
        tape = tape or self._load_tape(session_id)
        if turn_index < 0 or turn_index >= len(tape.turns):
            raise IndexError(
                f"turn_index {turn_index} out of range for session {session_id!r} "
                f"({len(tape.turns)} turns)",
            )

        record = tape.turns[turn_index]
        session = session_from_replay_snapshot(record.session_snapshot)
        classification = classification_from_dict(record.classification)
        original_graph = graph_from_dict(record.state_graph)
        original_diff = (
            diff_from_dict(record.state_graph_diff)
            if record.state_graph_diff
            else None
        )

        reconstructed_graph = _reconstruct_graph(session, record)
        reconstructed_policy = _reconstruct_execution_policy(
            session, classification, record,
        )

        reconstructed_diff: Optional[ConversationStateGraphDiff] = None
        if turn_index > 0:
            prev_record = tape.turns[turn_index - 1]
            prev_session = session_from_replay_snapshot(prev_record.session_snapshot)
            prev_graph = _reconstruct_graph(prev_session, prev_record)
            reconstructed_diff = diff_conversation_state_graph(
                prev_graph, reconstructed_graph,
            )

        mismatches: list[ReplayMismatch] = []
        for mismatch in _graphs_match(original_graph, reconstructed_graph):
            mismatches.append(
                ReplayMismatch(
                    turn_index, mismatch.category, mismatch.field,
                    mismatch.expected, mismatch.actual,
                ),
            )
        for mismatch in _diffs_match(original_diff, reconstructed_diff):
            mismatches.append(
                ReplayMismatch(
                    turn_index, mismatch.category, mismatch.field,
                    mismatch.expected, mismatch.actual,
                ),
            )
        if reconstructed_policy != (record.execution_policy or ""):
            mismatches.append(
                ReplayMismatch(
                    turn_index,
                    "execution_policy",
                    "policy",
                    record.execution_policy,
                    reconstructed_policy,
                ),
            )

        recorded_contract = resolve_recorded_contract(record, tape)
        replay_contract = current_execution_contract()
        contract_report = compare_execution_contracts(recorded_contract, replay_contract)

        return ReplayTurnResult(
            turn_index=turn_index,
            turn_id=record.turn_id,
            reconstructed_graph=reconstructed_graph,
            original_graph=original_graph,
            reconstructed_diff=reconstructed_diff,
            original_diff=original_diff,
            reconstructed_policy=reconstructed_policy,
            original_policy=record.execution_policy or "",
            classification=classification,
            recorded_contract=recorded_contract,
            replay_contract=replay_contract,
            contract_report=contract_report,
            mismatches=tuple(mismatches),
        )

    def replay_session(self, session_id: str) -> ConversationReplayResult:
        tape = self._load_tape(session_id)
        turn_results = tuple(
            self.replay_turn(session_id, index, tape=tape)
            for index in range(len(tape.turns))
        )
        all_mismatches = tuple(
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
        return ConversationReplayResult(
            session_id=session_id,
            turn_results=turn_results,
            mismatches=all_mismatches,
            contract_drifts=contract_drifts,
        )

    def validate_determinism(self, session_id: str) -> DeterminismReport:
        result = self.replay_session(session_id)
        return DeterminismReport(
            session_id=session_id,
            behavioral_determinism=result.behavioral_determinism,
            contract_compatibility=result.contract_compatibility,
            turn_count=len(result.turn_results),
            behavioral_mismatch_count=len(result.mismatches),
            contract_drift_count=len(result.contract_drifts),
            mismatches=result.mismatches,
            contract_drifts=result.contract_drifts,
            turn_results=result.turn_results,
        )

    def replay_session_segmented(self, session_id: str) -> "SegmentedReplayResult":
        """Replay session and split results into contract-version eras."""
        from .contract_aware_replay_segmentation import (
            SegmentedReplayResult,
            build_contract_segments,
        )

        replay_result = self.replay_session(session_id)
        tape = self._load_tape(session_id)
        segments = build_contract_segments(session_id, replay_result, tape)
        return SegmentedReplayResult(
            session_id=session_id,
            replay_result=replay_result,
            segments=segments,
        )

    def analyze_contract_evolution_impact(self, session_id: str) -> "ContractEvolutionReport":
        """Map contract-era drift to behavioral divergence — reporting only."""
        from .contract_aware_replay_segmentation import analyze_contract_evolution_impact

        return analyze_contract_evolution_impact(session_id, engine=self)


def log_conversation_replay_report(report: DeterminismReport) -> None:
    """Emit one observability line for replay validation — debugging only."""
    logger.info(
        "conversation_replay_report session_id=%s behavioral_determinism=%s "
        "contract_compatibility=%s turns=%s behavioral_mismatches=%s "
        "contract_drifts=%s",
        report.session_id,
        str(report.behavioral_determinism).lower(),
        str(report.contract_compatibility).lower(),
        report.turn_count,
        report.behavioral_mismatch_count,
        report.contract_drift_count,
    )
