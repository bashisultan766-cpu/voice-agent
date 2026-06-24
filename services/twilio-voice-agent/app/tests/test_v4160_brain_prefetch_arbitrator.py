"""v4.16.0 — BrainPrefetchArbitrator tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")


@pytest.mark.asyncio
class TestBrainPrefetchArbitrator:
    async def test_reject_catalog_for_greeting(self):
        from app.agent_runtime.brain_orchestrator import BrainDecision
        from app.agent_runtime.brain_prefetch_arbitrator import arbitrate_prefetch
        from app.agent_runtime.speculative_prefetch_manager import PrefetchResult, SpeculativePrefetchPacket

        decision = BrainDecision(
            response_mode="direct_answer",
            intent="small_talk",
            confidence=0.99,
            answer="I'm doing well, thank you.",
        )
        packet = SpeculativePrefetchPacket(
            prefetch_id="p1",
            user_text_hash="abc",
            started_at_ms=0,
            completed_at_ms=1,
            results=[
                PrefetchResult(
                    result_id="c1",
                    scout_name="catalog_scout",
                    kind="catalog_candidate",
                    confidence=0.55,
                    entities={"search_query": "Hello brother"},
                ),
                PrefetchResult(
                    result_id="cv1",
                    scout_name="conversation_scout",
                    kind="conversation_signal",
                    confidence=0.95,
                    entities={"signal": "greeting"},
                ),
            ],
        )
        ctx = arbitrate_prefetch(decision, packet)
        accepted_kinds = {r.kind for r in ctx.accepted_results}
        rejected_kinds = {r.kind for r in ctx.rejected_results}
        assert "catalog_candidate" in rejected_kinds
        assert "conversation_signal" in accepted_kinds

    async def test_accept_publication_for_catalog_intent(self):
        from app.agent_runtime.brain_orchestrator import BrainDecision, ToolPlan
        from app.agent_runtime.brain_prefetch_arbitrator import arbitrate_prefetch
        from app.agent_runtime.speculative_prefetch_manager import PrefetchResult, SpeculativePrefetchPacket

        decision = BrainDecision(
            response_mode="needs_tools",
            intent="newspaper_search",
            confidence=0.9,
            answer=None,
            tool_plan=ToolPlan(categories=["catalog_search"], intent="newspaper_search"),
        )
        packet = SpeculativePrefetchPacket(
            prefetch_id="p2",
            user_text_hash="def",
            started_at_ms=0,
            completed_at_ms=1,
            results=[
                PrefetchResult(
                    result_id="pub1",
                    scout_name="publication_scout",
                    kind="publication_candidate",
                    confidence=0.9,
                    entities={"product_kind": "newspaper"},
                ),
            ],
        )
        ctx = arbitrate_prefetch(decision, packet)
        assert len(ctx.accepted_results) == 1
        assert ctx.entities_for_tool_plan.get("product_kind") == "newspaper"
