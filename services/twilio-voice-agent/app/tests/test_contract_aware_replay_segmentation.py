"""ContractAwareReplaySegmentation — per-era replay reporting."""
from __future__ import annotations

from app.runtime.contract_aware_replay_segmentation import (
    analyze_contract_evolution_impact,
    build_contract_segments,
)
from app.runtime.conversation_replay_engine import ConversationReplayEngine
from app.runtime.conversation_replay_tape import (
    ConversationReplayTape,
    TurnObservabilityRecord,
    clear_replay_tape,
    register_replay_tape,
)
from app.runtime.execution_contract_versioning import (
    ExecutionContractVersion,
    contract_to_dict,
    current_execution_contract,
)
from app.tests.test_conversation_replay_engine import _register_two_turn_tape


def _register_multi_era_tape() -> ConversationReplayTape:
    clear_replay_tape("era-sess")
    base = _register_two_turn_tape()
    current = current_execution_contract()
    era_a = ExecutionContractVersion(
        fsm_version="v1.0-era-a",
        policy_version=current.policy_version,
        intent_schema_version=current.intent_schema_version,
        graph_schema_version=current.graph_schema_version,
    )
    era_b = ExecutionContractVersion(
        fsm_version="v1.0-era-b",
        policy_version=current.policy_version,
        intent_schema_version=current.intent_schema_version,
        graph_schema_version=current.graph_schema_version,
    )
    era_a_contract = contract_to_dict(era_a)
    era_b_contract = contract_to_dict(era_b)

    turn0 = base.turns[0]
    turn1 = base.turns[1]
    era_turns = [
        TurnObservabilityRecord(
            turn_index=turn0.turn_index,
            turn_id=turn0.turn_id,
            caller_text=turn0.caller_text,
            turn_mode=turn0.turn_mode,
            classification=turn0.classification,
            execution_policy=turn0.execution_policy,
            active_workflow=turn0.active_workflow,
            voice_stage=turn0.voice_stage,
            workflow_llm_blocked=turn0.workflow_llm_blocked,
            state_graph=turn0.state_graph,
            state_graph_diff=None,
            session_snapshot=turn0.session_snapshot,
            execution_contract=era_a_contract,
        ),
        TurnObservabilityRecord(
            turn_index=turn1.turn_index,
            turn_id=turn1.turn_id,
            caller_text=turn1.caller_text,
            turn_mode=turn1.turn_mode,
            classification=turn1.classification,
            execution_policy=turn1.execution_policy,
            active_workflow=turn1.active_workflow,
            voice_stage=turn1.voice_stage,
            workflow_llm_blocked=turn1.workflow_llm_blocked,
            state_graph=turn1.state_graph,
            state_graph_diff=turn1.state_graph_diff,
            session_snapshot=turn1.session_snapshot,
            execution_contract=era_b_contract,
        ),
    ]
    tape = ConversationReplayTape(
        session_id="era-sess",
        turns=era_turns,
        execution_contract=era_a_contract,
    )
    register_replay_tape(tape)
    return tape


def test_build_contract_segments_splits_on_contract_change():
    tape = _register_multi_era_tape()
    engine = ConversationReplayEngine()
    replay = engine.replay_session("era-sess")

    segments = build_contract_segments("era-sess", replay, tape)

    assert len(segments) == 2
    assert segments[0].start_turn_index == 0
    assert segments[0].end_turn_index == 0
    assert segments[0].execution_contract.fsm_version == "v1.0-era-a"
    assert segments[1].start_turn_index == 1
    assert segments[1].end_turn_index == 1
    assert segments[1].execution_contract.fsm_version == "v1.0-era-b"


def test_per_segment_determinism_report():
    tape = _register_multi_era_tape()
    segmented = ConversationReplayEngine().replay_session_segmented("era-sess")

    assert len(segmented.segments) == 2
    for segment in segmented.segments:
        report = segment.behavioral_determinism_result
        assert report.turn_count == segment.turn_count
        assert report.session_id == "era-sess"
        assert report.behavioral_determinism is True


def test_analyze_contract_evolution_impact_identifies_fsm_subsystem():
    _register_multi_era_tape()
    report = analyze_contract_evolution_impact("era-sess")

    assert report.era_count == 2
    assert len(report.behavioral_timeline) == 2
    assert all(deterministic for _, deterministic in report.behavioral_timeline)

    fsm_impacts = [i for i in report.subsystem_impacts if i.subsystem == "fsm"]
    assert len(fsm_impacts) == 1
    assert fsm_impacts[0].contract_field == "fsm_version"
    assert fsm_impacts[0].boundary_turn_index == 1

    boundary_map = report.contract_drift_vs_behavior_map[1]
    assert boundary_map.version_drift is True
    assert boundary_map.changed_subsystems == ("fsm",)
    assert boundary_map.behavioral_mismatch is False

    clear_replay_tape("era-sess")


def test_single_era_session_produces_one_segment():
    _register_two_turn_tape()
    segmented = ConversationReplayEngine().replay_session_segmented("replay-sess")

    assert len(segmented.segments) == 1
    assert segmented.segments[0].start_turn_index == 0
    assert segmented.segments[0].end_turn_index == 1
    clear_replay_tape("replay-sess")
