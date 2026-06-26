"""
ISBNFragmentAccumulatorWorker — collects ISBN digits across multiple turns (v4.7).

Uses isbn_validator for checksum validation and 979/978 prefix handling.
"""
from __future__ import annotations

import logging
import re
import time
from typing import TYPE_CHECKING

from ..pipeline.isbn_validator import (
    extract_digits as _extract_digits,
    is_valid_isbn_checksum as _is_valid_isbn,
    process_isbn_buffer,
)
from .base import WorkerResult

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_RESTART_RE = re.compile(
    r"\b(start over|restart|try again|that.?s wrong|let me start|begin again|never mind|repeat again)\b",
    re.IGNORECASE,
)


class ISBNFragmentAccumulatorWorker:
    name = "isbn_fragment"

    async def run(
        self,
        session: "SessionState",
        entities: dict,
        settings,
    ) -> WorkerResult:
        t0 = time.monotonic()
        text = entities.get("raw_text", "") or ""

        if _RESTART_RE.search(text):
            session.isbn_buffer = ""
            session.isbn_buffer_turn = -1
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={"action": "restarted"},
                safe_summary="No problem, let's start over. Please read the ISBN number.",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="local",
            )

        current_turn = getattr(session, "turn_count", 0)
        last_turn = getattr(session, "isbn_buffer_turn", -1)

        if last_turn >= 0 and (current_turn - last_turn) > 5:
            session.isbn_buffer = ""

        buf = getattr(session, "isbn_buffer", "") or ""
        from ..pipeline.isbn_validator import extract_digits

        if not extract_digits(text) and not buf:
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="no_digits",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="local",
            )

        result = process_isbn_buffer(text, buf, clear_on_repeat=False)

        if result.action == "cleared":
            session.isbn_buffer = ""
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={"action": "restarted"},
                safe_summary=result.message,
                latency_ms=(time.monotonic() - t0) * 1000,
                source="local",
            )

        session.isbn_buffer = result.buffer
        session.isbn_buffer_turn = current_turn

        if result.action == "complete" and result.isbn:
            history: list = getattr(session, "isbn_history", None)
            if history is None:
                session.isbn_history = []
                history = session.isbn_history
            if result.isbn not in history:
                history.append(result.isbn)
            session.isbn_buffer = ""
            entities["isbn"] = result.isbn
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={"isbn": result.isbn, "action": "complete"},
                safe_summary=result.message,
                latency_ms=(time.monotonic() - t0) * 1000,
                source="local",
            )

        return WorkerResult(
            worker_name=self.name,
            success=True,
            data={
                "action": result.action,
                "buffer": result.buffer,
                "count": len(result.buffer),
            },
            safe_summary=result.message,
            latency_ms=(time.monotonic() - t0) * 1000,
            source="local",
        )
