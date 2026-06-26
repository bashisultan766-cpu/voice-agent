"""v4.15.0 — Parallel multi-identifier search tests."""
from __future__ import annotations

import asyncio
import os
import time

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime.multi_identifier_search import search_identifiers_parallel_sync


class TestParallelMultiIdentifierSearch:
    def test_parallel_returns_partial_results(self):
        identifiers = [
            {"type": "isbn", "value": "9798994835500"},
            {"type": "isbn", "value": "9798893960648"},
            {"type": "isbn", "value": "fail-me"},
        ]

        def search_fn(ident):
            if ident["value"] == "fail-me":
                raise RuntimeError("not found")
            time.sleep(0.05)
            return [{"title": ident["value"], "variant_id": "v1"}]

        result = search_identifiers_parallel_sync(identifiers, search_fn, sid="CA4150P")
        assert len(result.found) == 2
        assert len(result.failed) == 1
        assert "trouble checking" in result.summary_message.lower() or "found" in result.summary_message.lower()

    def test_respects_concurrency_limit(self, monkeypatch):
        monkeypatch.setenv("VOICE_CATALOG_PARALLEL_SEARCH_LIMIT", "2")
        from app.config import get_settings
        get_settings.cache_clear()

        active = 0
        peak = 0

        async def slow_search(ident):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0.1)
            active -= 1
            return [{"title": ident["value"]}]

        from app.agent_runtime.multi_identifier_search import search_identifiers_parallel

        ids = [{"value": str(i)} for i in range(4)]
        asyncio.run(search_identifiers_parallel(ids, slow_search, sid="CA4150P"))
        assert peak <= 2

    def test_mutating_not_in_parallel_module(self):
        """Parallel module is read-only search only."""
        from app.agent_runtime import multi_identifier_search
        assert hasattr(multi_identifier_search, "search_identifiers_parallel")
        assert not hasattr(multi_identifier_search, "add_to_cart")
