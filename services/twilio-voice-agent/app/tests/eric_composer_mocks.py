"""Shared test helpers for Eric runtime composer mocking (v4.12)."""
from __future__ import annotations

from contextlib import ExitStack, contextmanager
from unittest.mock import AsyncMock, patch

from app.workers.base import WorkerBundle


@contextmanager
def patch_eric_runtime_composer(
    engine,
    *,
    stream_fn=None,
    final_text: str = "Hello there",
    final_fn=None,
    worker_bundle=None,
):
    """
    Patch orchestrator + composer for Eric Agent Runtime tests.

    v4.12 uses compose_final_response for conversational turns; legacy tests
    only patched stream_response.
    """
    bundle = worker_bundle if worker_bundle is not None else WorkerBundle()
    final_mock = final_fn if final_fn is not None else AsyncMock(return_value=final_text)

    with ExitStack() as stack:
        stack.enter_context(
            patch.object(engine._orchestrator, "run", AsyncMock(return_value=bundle))
        )
        stack.enter_context(
            patch.object(engine._composer, "compose_final_response", final_mock)
        )
        if stream_fn is not None:
            stack.enter_context(
                patch.object(engine._composer, "stream_response", stream_fn)
            )
        yield
