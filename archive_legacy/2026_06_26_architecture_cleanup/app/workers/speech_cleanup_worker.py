"""SpeechCleanupWorker — normalizes ASR artifacts before routing (Wave 1, no-op stub)."""
from __future__ import annotations
import time
from .base import WorkerResult


class SpeechCleanupWorker:
    name = "speech_cleanup"

    async def run(self, session, entities, settings) -> WorkerResult:
        t0 = time.monotonic()
        return WorkerResult(
            worker_name=self.name,
            success=True,
            data={"cleaned": entities.get("raw_text", "")},
            latency_ms=(time.monotonic() - t0) * 1000,
            source="local",
        )
