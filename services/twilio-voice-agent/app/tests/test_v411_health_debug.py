"""v4.11 — Health and debug script tests."""
from __future__ import annotations

import os
import sys

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")


@pytest.mark.asyncio
async def test_health_safe():
    from app.api.health import health
    result = await health()
    assert result["ok"] is True
    assert "runtime_mode" in result
    assert "llm_brain_enabled" in result
    assert "memory_turns" in result
    assert "api_key" not in str(result).lower()
    assert "secret" not in str(result).lower()


def test_debug_script_safe():
    root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
    sys.path.insert(0, root)
    from scripts.check_agent_runtime import main
    assert main() == 0
