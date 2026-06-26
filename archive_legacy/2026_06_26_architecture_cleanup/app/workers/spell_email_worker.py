"""SpellEmailWorker — deterministic email spell-back (v4.3)."""
from __future__ import annotations

import time

from ..dialogue.manager import DialogueManager
from .base import WorkerResult


class SpellEmailWorker:
    name = "spell_email"

    async def run(self, session, entities, settings) -> WorkerResult:
        t0 = time.monotonic()
        text = DialogueManager.build_spell_email_response(session)
        return WorkerResult(
            worker_name=self.name,
            success=True,
            data={"spell_back": text},
            safe_summary=text,
            latency_ms=(time.monotonic() - t0) * 1000,
            source="local",
        )
