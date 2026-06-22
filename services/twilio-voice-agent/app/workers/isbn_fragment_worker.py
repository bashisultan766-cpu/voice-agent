"""
ISBNFragmentAccumulatorWorker — collects ISBN digits across multiple turns.

Live production issue: callers give ISBNs as fragments across turns:
  turn 1: "9 7 8"
  turn 2: "1 4 0 0"
  turn 3: "3 5 7 9 4 9"
This worker accumulates digits until 10 or 13 are collected, then triggers search.
"""
from __future__ import annotations

import logging
import re
import time
from typing import TYPE_CHECKING

from .base import WorkerResult

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_DIGIT_WORDS = {
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4",
    "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
    "oh": "0",
}
_RESTART_RE = re.compile(
    r"\b(start over|restart|try again|that.?s wrong|let me start|begin again|never mind)\b",
    re.IGNORECASE,
)


def _extract_digits(text: str) -> str:
    t = text.strip().lower()
    for word, digit in _DIGIT_WORDS.items():
        t = re.sub(rf"\b{word}\b", digit, t)
    return re.sub(r"[^0-9xX]", "", t).upper()


def _is_valid_isbn(digits: str) -> bool:
    d = digits.replace("-", "").replace(" ", "")
    if len(d) == 10:
        try:
            total = sum((10 - i) * (10 if c == "X" else int(c)) for i, c in enumerate(d))
            return total % 11 == 0
        except ValueError:
            return False
    if len(d) == 13:
        try:
            total = sum(int(c) * (1 if i % 2 == 0 else 3) for i, c in enumerate(d))
            return total % 10 == 0
        except ValueError:
            return False
    return False


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
                safe_summary="No problem, let's start over. Please give me the ISBN number.",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="local",
            )

        current_turn = getattr(session, "turn_count", 0)
        last_turn = getattr(session, "isbn_buffer_turn", -1)

        if last_turn >= 0 and (current_turn - last_turn) > 5:
            session.isbn_buffer = ""

        new_digits = _extract_digits(text)
        buf = (getattr(session, "isbn_buffer", "") or "") + new_digits

        if not new_digits:
            if buf:
                return WorkerResult(
                    worker_name=self.name,
                    success=True,
                    data={"action": "awaiting_more", "buffer": buf},
                    safe_summary=f"I have {buf} so far. Please continue with the next digits.",
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="local",
                )
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="no_digits",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="local",
            )

        session.isbn_buffer = buf
        session.isbn_buffer_turn = current_turn

        if len(buf) >= 10:
            candidate_13 = buf[:13] if len(buf) >= 13 else None
            candidate_10 = buf[:10]

            isbn = None
            if candidate_13 and _is_valid_isbn(candidate_13):
                isbn = candidate_13
            elif _is_valid_isbn(candidate_10):
                isbn = candidate_10
            elif len(buf) >= 13:
                isbn = buf[:13]

            if isbn:
                history: list = getattr(session, "isbn_history", None)
                if history is None:
                    session.isbn_history = []
                    history = session.isbn_history
                if isbn not in history:
                    history.append(isbn)
                session.isbn_buffer = ""
                return WorkerResult(
                    worker_name=self.name,
                    success=True,
                    data={"isbn": isbn, "action": "complete"},
                    safe_summary=f"ISBN {isbn} captured.",
                    latency_ms=(time.monotonic() - t0) * 1000,
                    source="local",
                )

        return WorkerResult(
            worker_name=self.name,
            success=True,
            data={"action": "accumulating", "buffer": buf, "count": len(buf)},
            safe_summary=f"I have {buf} so far. Please continue with the next digits.",
            latency_ms=(time.monotonic() - t0) * 1000,
            source="local",
        )
