"""Parallel tool executor — runs independent planner steps concurrently."""
from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

from .tool_router import execute_step, is_read_only_tool
from .types import PlanStep, PlannerResult, ToolExecutionResult

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)


async def execute_plan(
    plan: PlannerResult,
    session: "SessionState",
    *,
    turn_id: str = "",
    timeout_ms: int = 2500,
) -> list[ToolExecutionResult]:
    """Execute planner steps respecting dependencies and parallel flags."""
    if plan.blocked or not plan.steps:
        return []

    results: list[ToolExecutionResult] = []
    completed: set[str] = set()

    parallel_batch: list[PlanStep] = []
    sequential: list[PlanStep] = []

    for step in plan.steps:
        if step.can_run_parallel and is_read_only_tool(step.tool) and not step.depends_on:
            parallel_batch.append(step)
        else:
            sequential.append(step)

    if parallel_batch:
        batch_results = await _run_parallel(parallel_batch, session, turn_id=turn_id, timeout_ms=timeout_ms)
        results.extend(batch_results)
        completed.update(r.tool for r in batch_results)

    for step in sequential:
        if step.depends_on and not all(dep in completed for dep in step.depends_on):
            logger.warning(
                "parallel_executor_skip_unmet_deps tool=%s deps=%s",
                step.tool,
                step.depends_on,
            )
            continue
        result = await execute_step(step, session, turn_id=turn_id, timeout_ms=timeout_ms)
        results.append(result)
        completed.add(result.tool)

    return results


async def _run_parallel(
    steps: list[PlanStep],
    session: "SessionState",
    *,
    turn_id: str,
    timeout_ms: int,
) -> list[ToolExecutionResult]:
    if len(steps) == 1:
        return [await execute_step(steps[0], session, turn_id=turn_id, timeout_ms=timeout_ms)]

    logger.info(
        "parallel_executor_batch sid=%s count=%d tools=%s",
        (session.call_sid or "")[:6],
        len(steps),
        ",".join(s.tool for s in steps),
    )

    tasks = [
        execute_step(step, session, turn_id=turn_id, timeout_ms=timeout_ms)
        for step in steps
    ]
    raw = await asyncio.gather(*tasks, return_exceptions=True)

    out: list[ToolExecutionResult] = []
    for item in raw:
        if isinstance(item, Exception):
            out.append(
                ToolExecutionResult(
                    tool="unknown",
                    success=False,
                    result={"success": False, "error": str(item)},
                    error_code=type(item).__name__,
                )
            )
        else:
            out.append(item)
    return out
