"""
Turn memory contract — append-only immutable logs per turn.

Only TurnController may append. Planner and tools never write history directly.
"""
from __future__ import annotations

import time
from copy import deepcopy
from dataclasses import asdict
from typing import Any, Optional

from .session_state import V2SessionState
from .types import Plan, ToolExecutionResult


def _ts() -> float:
    return time.time()


def append_turn_record(
    state: V2SessionState,
    *,
    turn_id: int,
    user_text: str,
    policy: dict[str, Any],
    planner_plan: dict[str, Any],
    tool_chain: list[dict[str, Any]],
    composed_text: str,
    trace: dict[str, Any],
    commit_patches: dict[str, Any],
    skipped: bool = False,
) -> None:
    record = {
        "turn_id": turn_id,
        "ts": _ts(),
        "user_text": user_text,
        "policy": deepcopy(policy),
        "planner_plan": deepcopy(planner_plan),
        "tool_chain": deepcopy(tool_chain),
        "composed_text": composed_text,
        "trace": deepcopy(trace),
        "commit_patches": deepcopy(commit_patches),
        "skipped": skipped,
        "stage_after": state.conversation_stage,
    }
    state.turn_history.append(record)


def append_tool_history(state: V2SessionState, entries: list[dict[str, Any]]) -> None:
    for entry in entries:
        state.tool_history.append({**deepcopy(entry), "ts": _ts()})


def append_state_transition(
    state: V2SessionState,
    *,
    turn_id: int,
    from_stage: str,
    to_stage: str,
    reason: str,
    patches: dict[str, Any],
) -> None:
    state.state_transitions.append({
        "turn_id": turn_id,
        "ts": _ts(),
        "from_stage": from_stage,
        "to_stage": to_stage,
        "reason": reason,
        "patches": deepcopy(patches),
    })


def derive_commit_patches(
    state: V2SessionState,
    plan: Plan,
    *,
    policy_patches: dict[str, Any],
    tool_patches: dict[str, Any],
) -> dict[str, Any]:
    """Merge commit patches from policy + tools only (planner never mutates)."""
    merged: dict[str, Any] = {}
    merged.update(policy_patches or {})
    merged.update(tool_patches or {})

    if plan.stage_hint and "conversation_stage" not in merged:
        merged["conversation_stage"] = plan.stage_hint

    if plan.reason in ("interrupt_repeat", "interrupt_continue"):
        merged["interrupt_flag"] = False

    return merged


def build_tool_chain_log(results: list[ToolExecutionResult]) -> list[dict[str, Any]]:
    return [
        {
            "step": idx + 1,
            "tool": r.tool,
            "ok": r.ok,
            "error": r.error,
            "data_keys": list((r.data or {}).keys())[:12],
        }
        for idx, r in enumerate(results)
    ]


def merge_tool_patches(results: list[ToolExecutionResult]) -> dict[str, Any]:
    merged: dict[str, Any] = {}
    for r in results:
        if r.state_patches:
            merged.update(r.state_patches)
    return merged


def snapshot_stage(state: V2SessionState) -> str:
    return state.conversation_stage
