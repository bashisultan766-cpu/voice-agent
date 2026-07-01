"""ExecutionContractVersioningLayer — contract-aware replay validation."""
from __future__ import annotations

from app.runtime.conversation_replay_engine import ConversationReplayEngine
from app.runtime.conversation_replay_tape import (
    ConversationReplayTape,
    TurnObservabilityRecord,
    clear_replay_tape,
    register_replay_tape,
)
from app.runtime.execution_contract_versioning import (
    ExecutionContractVersion,
    compare_execution_contracts,
    contract_to_dict,
    current_execution_contract,
)
from app.tests.test_conversation_replay_engine import _register_two_turn_tape


def test_compare_execution_contracts_compatible():
    current = current_execution_contract()
    report = compare_execution_contracts(current, current)
    assert report.compatible is True
    assert not report.has_version_drift


def test_compare_execution_contracts_detects_drift():
    recorded = ExecutionContractVersion(
        fsm_version="v0.0",
        policy_version="v0.0",
        intent_schema_version="v0.0",
        graph_schema_version="v0.0",
    )
    current = current_execution_contract()
    report = compare_execution_contracts(recorded, current)
    assert report.compatible is False
    assert report.has_version_drift
    fields = {m.field for m in report.mismatches}
    assert "fsm_version" in fields
    assert "policy_version" in fields


def test_validate_determinism_splits_behavioral_and_contract():
    tape = _register_two_turn_tape()
    current = current_execution_contract()
    drifted = ExecutionContractVersion(
        fsm_version="v0.0-legacy",
        policy_version=current.policy_version,
        intent_schema_version=current.intent_schema_version,
        graph_schema_version=current.graph_schema_version,
    )
    drift_contract = contract_to_dict(drifted)
    drifted_turns = [
        TurnObservabilityRecord(
            turn_index=turn.turn_index,
            turn_id=turn.turn_id,
            caller_text=turn.caller_text,
            turn_mode=turn.turn_mode,
            classification=turn.classification,
            execution_policy=turn.execution_policy,
            active_workflow=turn.active_workflow,
            voice_stage=turn.voice_stage,
            workflow_llm_blocked=turn.workflow_llm_blocked,
            state_graph=turn.state_graph,
            state_graph_diff=turn.state_graph_diff,
            session_snapshot=turn.session_snapshot,
            execution_contract=drift_contract,
        )
        for turn in tape.turns
    ]
    register_replay_tape(
        ConversationReplayTape(
            session_id="replay-sess",
            turns=drifted_turns,
            execution_contract=drift_contract,
        ),
    )

    report = ConversationReplayEngine().validate_determinism("replay-sess")

    assert report.contract_compatibility is False
    assert report.contract_drift_count == 2
    assert report.behavioral_determinism is True
    clear_replay_tape("replay-sess")
