"""QuantityExtractorWorker — extracts book quantity from caller utterance."""
from __future__ import annotations
import re
import time
from .base import WorkerResult

_DIGIT_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
                "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10}
_QTY_PAT = re.compile(r"\b(\d+)\s+(?:cop(?:y|ies)|book|item)", re.IGNORECASE)


class QuantityExtractorWorker:
    name = "quantity_extractor"

    async def run(self, session, entities, settings) -> WorkerResult:
        t0 = time.monotonic()
        qty = entities.get("quantity", 0) or 0
        if not qty:
            text = (entities.get("raw_text", "") or "").lower()
            m = _QTY_PAT.search(text)
            if m:
                qty = int(m.group(1))
            else:
                for word, val in _DIGIT_WORDS.items():
                    if re.search(rf"\b{word}\b\s+cop|\b{word}\b\s+book", text):
                        qty = val
                        break
        return WorkerResult(
            worker_name=self.name,
            success=qty > 0,
            data={"quantity": qty or 1},
            latency_ms=(time.monotonic() - t0) * 1000,
            source="local",
        )
