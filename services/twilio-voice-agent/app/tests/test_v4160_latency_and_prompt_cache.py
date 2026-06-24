"""v4.16.0 — Latency and prompt cache tests."""
from __future__ import annotations

import os
import time

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")


def _settings(**overrides):
    from app.config import Settings
    defaults = dict(
        OPENAI_API_KEY="test",
        DEBUG=True,
        ERIC_PROMPT_PACK_ENABLED=True,
        VOICE_BRAIN_DETERMINISTIC_GREETING_FASTPATH=True,
        VOICE_PREFETCH_MAX_WAIT_MS=350,
    )
    defaults.update(overrides)
    return Settings(**defaults)


class TestLatencyAndPromptCache:
    def test_prompt_pack_cache_hit(self):
        from app.agent_runtime import prompt_pack_loader as ppl
        from app.agent_runtime.prompt_pack_loader import clear_prompt_pack_cache, load_prompt_pack

        clear_prompt_pack_cache()
        snap1 = load_prompt_pack()
        snap2 = load_prompt_pack()
        assert snap1.prompt_hash == snap2.prompt_hash
        assert ppl._last_cache_hit is True

    def test_stable_prefix_in_prompt_pack(self):
        from app.agent_runtime.prompt_pack_loader import load_prompt_pack

        snap = load_prompt_pack()
        assert snap.text.startswith("#") or "Eric" in snap.text[:200]

    @pytest.mark.asyncio
    async def test_prefetch_max_wait_respected(self):
        from app.agent_runtime.speculative_prefetch_manager import SpeculativePrefetchManager, wait_for_prefetch
        import asyncio

        mgr = SpeculativePrefetchManager(_settings(VOICE_PREFETCH_MAX_WAIT_MS=50))
        task = asyncio.create_task(mgr.prefetch(call_sid="CA4160", user_text="Hello"))
        t0 = time.monotonic()
        result = await wait_for_prefetch(task, 50)
        elapsed = (time.monotonic() - t0) * 1000
        assert elapsed < 200
        if result is None:
            task.cancel()

    @pytest.mark.asyncio
    async def test_brain_timeout_fallback_domain_safe(self, monkeypatch):
        from app.agent_runtime.brain_orchestrator import BrainOrchestrator, BrainOrchestratorInput

        async def _fail(*args, **kwargs):
            raise TimeoutError("simulated")

        monkeypatch.setattr(
            "app.agent_runtime.brain_orchestrator.AsyncOpenAI",
            lambda **kw: type("C", (), {"chat": type("Chat", (), {"completions": type("Comp", (), {"create": _fail})()})()})(),
        )
        brain = BrainOrchestrator(_settings(VOICE_BRAIN_DETERMINISTIC_GREETING_FASTPATH=False, VOICE_BRAIN_TIMEOUT_MS=100))
        decision = await brain.decide(
            BrainOrchestratorInput(call_sid="CA4160", user_text="Something ambiguous xyz123")
        )
        assert decision.response_mode == "clarify"
        assert "SureShot" in (decision.answer or "")
