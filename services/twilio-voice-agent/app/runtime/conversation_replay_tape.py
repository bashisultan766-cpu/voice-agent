"""
Conversation replay tape — durable in-memory turn observability bundles.

Records ConversationStateGraph snapshots, diffs, and buffered classifier results
for ConversationReplayEngine. Does not touch FSMs or routing authority.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, TYPE_CHECKING

from .conversation_replay_codec import (
    capture_session_replay_snapshot,
    classification_to_dict,
    diff_to_dict,
    graph_to_dict,
)
from .execution_contract_versioning import (
    contract_to_dict,
    current_execution_contract,
)
from .conversation_state_graph import ConversationStateGraph
from .conversation_state_graph_diff import ConversationStateGraphDiff
from .fast_classifier import ClassificationResult

if TYPE_CHECKING:
    from ..state.models import SessionState

CONVERSATION_REPLAY_TAPE_VERSION = "v1.0"


@dataclass(frozen=True)
class TurnObservabilityRecord:
    """One turn's observability bundle — no live LLM dependency."""

    turn_index: int
    turn_id: str
    caller_text: str
    turn_mode: str
    classification: dict[str, Any]
    execution_policy: str
    active_workflow: str
    voice_stage: str
    workflow_llm_blocked: bool
    state_graph: dict[str, Any]
    state_graph_diff: Optional[dict[str, Any]] = None
    session_snapshot: dict[str, Any] = field(default_factory=dict)
    execution_contract: dict[str, Any] = field(default_factory=dict)


@dataclass
class ConversationReplayTape:
    session_id: str
    version: str = CONVERSATION_REPLAY_TAPE_VERSION
    turns: list[TurnObservabilityRecord] = field(default_factory=list)
    execution_contract: dict[str, Any] = field(default_factory=dict)


_TAPES: dict[str, ConversationReplayTape] = {}


def register_replay_tape(tape: ConversationReplayTape) -> None:
    _TAPES[tape.session_id] = tape


def load_replay_tape(session_id: str) -> Optional[ConversationReplayTape]:
    return _TAPES.get(session_id)


def clear_replay_tape(session_id: str) -> None:
    _TAPES.pop(session_id, None)


def record_turn_observability(
    session: "SessionState",
    *,
    turn_index: int,
    turn_id: str,
    caller_text: str,
    turn_mode: str,
    classification: ClassificationResult,
    execution_policy: str,
    active_workflow: str,
    voice_stage: str,
    workflow_llm_blocked: bool,
    state_graph: ConversationStateGraph,
    state_graph_diff: Optional[ConversationStateGraphDiff] = None,
) -> TurnObservabilityRecord:
    """
    Append one turn bundle to the in-memory replay tape for this session.

    Read-only with respect to FSM / routing state — only writes the tape store.
    """
    session_id = (
        getattr(session, "session_id", "") or getattr(session, "call_sid", "") or ""
    ).strip()
    tape = _TAPES.setdefault(
        session_id or f"anonymous-{id(session)}",
        ConversationReplayTape(session_id=session_id or "anonymous"),
    )
    contract = current_execution_contract()
    if not tape.execution_contract:
        tape.execution_contract = contract_to_dict(contract)
    record = TurnObservabilityRecord(
        turn_index=turn_index,
        turn_id=turn_id or str(turn_index),
        caller_text=caller_text,
        turn_mode=turn_mode,
        classification=classification_to_dict(classification),
        execution_policy=execution_policy,
        active_workflow=active_workflow,
        voice_stage=voice_stage,
        workflow_llm_blocked=workflow_llm_blocked,
        state_graph=graph_to_dict(state_graph),
        state_graph_diff=(
            diff_to_dict(state_graph_diff) if state_graph_diff else None
        ),
        session_snapshot=capture_session_replay_snapshot(session),
        execution_contract=contract_to_dict(
            state_graph.execution_contract if state_graph.execution_contract else contract,
        ),
    )
    tape.turns.append(record)
    return record
