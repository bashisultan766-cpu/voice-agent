"""BookTitleExtractorWorker — extracts book title from caller utterance."""
from __future__ import annotations
import re
import time
from .base import WorkerResult

_TITLE_PATS = [
    re.compile(r'(?:book|title|called|named|the book)\s+["\']?(.+?)["\']?$', re.IGNORECASE),
    re.compile(r'["\'](.+?)["\']'),
]


class BookTitleExtractorWorker:
    name = "book_title_extractor"

    async def run(self, session, entities, settings) -> WorkerResult:
        t0 = time.monotonic()
        phrase = entities.get("product_phrase", "") or entities.get("raw_text", "") or ""
        title = phrase
        for pat in _TITLE_PATS:
            m = pat.search(phrase)
            if m:
                title = m.group(1).strip()
                break
        if title and not session.last_product_title:
            session.last_product_title = title
        return WorkerResult(
            worker_name=self.name,
            success=bool(title),
            data={"extracted_title": title},
            latency_ms=(time.monotonic() - t0) * 1000,
            source="local",
        )
