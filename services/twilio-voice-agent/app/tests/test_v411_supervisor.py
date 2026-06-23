"""v4.11 — LLM Supervisor tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")


def _session():
    from app.state.models import SessionState
    return SessionState(
        session_id="s411",
        call_sid="CA00000411",
        from_number="+15550001111",
        to_number="+15559998888",
    )


def _memory():
    from app.agent_runtime.memory_packet import MemoryPacket
    return MemoryPacket()


def _state():
    from app.agent_runtime.types import StatePacket
    return StatePacket()


@pytest.mark.asyncio
class TestLLMSupervisor:
    async def test_politics_factual_out_of_domain(self):
        from app.agent_runtime.llm_supervisor import get_supervisor
        s = get_supervisor()
        session = _session()
        d = await s.decide(session, "Who is Donald Trump?", _memory(), _state())
        assert d.user_intent == "out_of_domain"
        assert d.domain_boundary == "outside_domain_redirect"

    async def test_books_about_politics_catalog_search(self):
        from app.agent_runtime.llm_supervisor import get_supervisor
        s = get_supervisor()
        session = _session()
        d = await s.decide(
            session, "Do you have books about Donald Trump?", _memory(), _state(),
        )
        assert d.user_intent == "book_topic_allowed"
        assert any(w.worker == "catalog_search" for w in d.worker_requests)

    async def test_name_answered_directly(self):
        from app.agent_runtime.llm_supervisor import get_supervisor
        s = get_supervisor()
        session = _session()
        d = await s.decide(session, "What is your name?", _memory(), _state())
        assert d.user_intent == "identity"
        assert not d.worker_requests or d.worker_requests[0].worker == "none"

    async def test_job_answered_directly(self):
        from app.agent_runtime.llm_supervisor import get_supervisor
        s = get_supervisor()
        session = _session()
        d = await s.decide(session, "What is your job?", _memory(), _state())
        assert d.user_intent == "job_question"

    async def test_order_routes_order_lookup(self):
        from app.agent_runtime.llm_supervisor import get_supervisor
        s = get_supervisor()
        session = _session()
        d = await s.decide(
            session, "I want to check my order", _memory(), _state(),
            router_intent="order_lookup",
        )
        assert d.user_intent == "order_lookup"
        assert any(w.worker == "order_lookup" for w in d.worker_requests)

    async def test_shipping_routes_shipping_lookup(self):
        from app.agent_runtime.llm_supervisor import get_supervisor
        s = get_supervisor()
        session = _session()
        d = await s.decide(session, "What is the shipping cost?", _memory(), _state())
        assert d.user_intent == "shipping_question"

    async def test_facility_routes_facility_approval(self):
        from app.agent_runtime.llm_supervisor import get_supervisor
        s = get_supervisor()
        session = _session()
        d = await s.decide(
            session, "Is this facility approved?", _memory(), _state(),
        )
        assert d.user_intent == "facility_approval"

    async def test_wait_phrase_holds(self):
        from app.agent_runtime.llm_supervisor import get_supervisor
        s = get_supervisor()
        session = _session()
        d = await s.decide(session, "Wait hold on one second", _memory(), _state())
        assert d.should_wait_for_more_speech

    async def test_no_tools_in_supervisor_call(self):
        from unittest.mock import AsyncMock, patch
        from app.agent_runtime.llm_supervisor import LLMSupervisor

        session = _session()
        sup = LLMSupervisor()
        with patch("app.agent_runtime.llm_supervisor.AsyncOpenAI") as mock_cls:
            mock_client = AsyncMock()
            mock_cls.return_value = mock_client
            mock_client.chat.completions.create = AsyncMock(
                return_value=type("R", (), {
                    "choices": [type("C", (), {
                        "message": type("M", (), {"content": '{"user_intent":"unknown","confidence":0.5}'})(),
                    })()],
                })(),
            )
            await sup.decide(
                session, "something obscure xyz", _memory(), _state(),
                router_intent="unknown",
            )
            call_kwargs = mock_client.chat.completions.create.call_args.kwargs
            assert "tools" not in call_kwargs

    async def test_json_parse_fallback(self):
        from unittest.mock import AsyncMock, patch
        from app.agent_runtime.llm_supervisor import LLMSupervisor

        session = _session()
        sup = LLMSupervisor()
        with patch("app.agent_runtime.llm_supervisor._call_llm_supervisor", AsyncMock(return_value=None)):
            d = await sup.decide(
                session, "obscure query xyz123", _memory(), _state(),
                router_intent="unknown",
            )
            assert d.source == "fallback"
            assert d.user_intent == "unknown"
