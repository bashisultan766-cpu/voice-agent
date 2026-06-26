"""v4.16.0 — SpeculativePrefetchManager tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")


def _settings(**overrides):
    from app.config import Settings
    defaults = dict(
        OPENAI_API_KEY="test",
        DEBUG=True,
        VOICE_SPECULATIVE_PREFETCH_ENABLED=True,
        VOICE_PREFETCH_SCOUT_TIMEOUT_MS=300,
    )
    defaults.update(overrides)
    return Settings(**defaults)


@pytest.mark.asyncio
class TestSpeculativePrefetchManager:
    async def test_prefetch_starts_scouts_in_parallel(self):
        from app.agent_runtime.speculative_prefetch_manager import SpeculativePrefetchManager

        mgr = SpeculativePrefetchManager(_settings())
        packet = await mgr.prefetch(call_sid="CA4160", user_text="Hello. How are you, brother?")
        assert packet.prefetch_id
        assert len(packet.results) >= 1
        scout_names = {r.scout_name for r in packet.results}
        assert "conversation_scout" in scout_names

    async def test_scouts_return_no_final_answer(self):
        from app.agent_runtime.speculative_prefetch_manager import SpeculativePrefetchManager

        packet = await SpeculativePrefetchManager(_settings()).prefetch(
            call_sid="CA4160", user_text="ISBN 9780441172719"
        )
        for result in packet.results:
            assert "answer" not in result.facts
            assert "response_text" not in result.facts

    async def test_scout_timeout_respected(self):
        from app.agent_runtime.speculative_prefetch_manager import SpeculativePrefetchManager

        packet = await SpeculativePrefetchManager(
            _settings(VOICE_PREFETCH_SCOUT_TIMEOUT_MS=100)
        ).prefetch(call_sid="CA4160", user_text="USA Today newspaper 3 months")
        assert packet.completed_at_ms >= packet.started_at_ms

    async def test_disabled_prefetch(self):
        from app.agent_runtime.speculative_prefetch_manager import SpeculativePrefetchManager

        packet = await SpeculativePrefetchManager(
            _settings(VOICE_SPECULATIVE_PREFETCH_ENABLED=False)
        ).prefetch(call_sid="CA4160", user_text="Hello")
        assert packet.results == []
