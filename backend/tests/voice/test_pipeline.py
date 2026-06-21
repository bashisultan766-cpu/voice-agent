"""Tests for VoicePipeline coordinator delegation."""
from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from app.tools.base import ToolContext
from app.voice.pipeline import VoicePipeline


@pytest.fixture()
def tool_context():
    return ToolContext(
        agent_id="agent-1",
        tenant_id="tenant-1",
        call_sid="CA-test-456",
        shopify_store_url="https://shop.myshopify.com",
        shopify_api_token="shpat_test",
        openai_api_key="sk-test",
    )


@pytest.fixture()
def fake_registry():
    registry = MagicMock()
    registry.schemas.return_value = []
    registry.execute = AsyncMock(return_value='{"found": true}')
    return registry


@pytest.mark.asyncio
async def test_pipeline_delegates_to_orchestrator(tool_context, fake_registry):
    pipeline = VoicePipeline(
        agent_id="agent-1",
        tenant_id="tenant-1",
        call_sid="CA-test-456",
        system_prompt="You are helpful.",
        tool_registry=fake_registry,
        tool_context=tool_context,
        use_openai_tts=False,
    )

    with (
        patch("app.voice.orchestrator.cache_get", new_callable=AsyncMock, return_value=[]),
        patch("app.voice.orchestrator.cache_set", new_callable=AsyncMock),
        patch("app.voice.orchestrator.run_agentic_loop", new_callable=AsyncMock,
              return_value=("Hello!", [])),
    ):
        result = await pipeline.process_turn("hi there friend")

    assert isinstance(result, dict)
    assert "text" in result
    assert "latency_breakdown" in result
    assert "intent" in result
