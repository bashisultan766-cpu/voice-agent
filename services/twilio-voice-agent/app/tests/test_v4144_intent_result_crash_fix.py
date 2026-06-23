"""v4.14.4 — IntentResult crash fix regression."""
from __future__ import annotations

import os
from unittest.mock import AsyncMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")


@pytest.fixture
def settings():
    from app.config import get_settings
    return get_settings()


class TestIntentResultCrashFix:
    def test_build_intent_result_includes_confidence(self, settings):
        from app.agent_runtime.intent_result_builder import _build_intent_result_from_agent_decision

        decision = {
            "intent": "isbn_lookup",
            "confidence": 0.97,
            "tool_categories": ["isbn_lookup", "catalog_search"],
            "search_query": "9798993861807",
            "tool_entities": {"isbn": "9798993861807"},
        }
        result = _build_intent_result_from_agent_decision(
            decision, "ISBN is 9798993861807",
        )
        assert result.confidence == 0.97
        assert result.entities.get("isbn") == "9798993861807"
        assert result.intent == "isbn_lookup"

    @pytest.mark.asyncio
    async def test_isbn_turn_does_not_raise_typeerror(self, settings):
        from app.agent_runtime.runtime import EricAgentRuntime
        from app.state.models import SessionState

        runtime = EricAgentRuntime(settings=settings)
        session = SessionState(
            session_id="sess4144crash",
            call_sid="CA4144CRASH",
            from_number="+15551234567",
            to_number="+15559876543",
        )
        sent = []

        async def send(msg):
            sent.append(msg)

        decision = {
            "response_mode": "needs_tools",
            "intent": "isbn_lookup",
            "confidence": 0.97,
            "direct_answer": "",
            "tool_categories": ["isbn_lookup", "catalog_search"],
            "tool_reason": "isbn_digits_present",
            "search_query": "9798993861807",
            "tool_entities": {"isbn": "9798993861807"},
        }

        with patch(
            "app.agent_runtime.runtime.main_llm_agent_decide",
            new_callable=AsyncMock,
            return_value=decision,
        ), patch(
            "app.workers.orchestrator._run_one",
            new_callable=AsyncMock,
        ) as mock_run:
            from app.workers.base import WorkerResult

            mock_run.return_value = WorkerResult(
                worker_name="product_isbn",
                success=True,
                safe_summary="Found Test Book",
                source="cache",
            )
            result = await runtime.handle_turn(
                session, "ISBN is 9798993861807", send,
            )

        assert result.response_text or sent
        mock_run.assert_called()
