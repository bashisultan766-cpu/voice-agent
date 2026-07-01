"""
Emergency production latency fix — Postgres circuit breaker and deterministic fast paths.
"""
from __future__ import annotations

import asyncio
import logging
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.config import Settings, get_settings
from app.db import connection as db_connection
from app.memory import postgres_store
from app.orchestrator.intent_router import (
    classify_intent_heuristic,
    is_incomplete_utterance,
    is_smalltalk,
    resolve_smalltalk_response,
)
from app.orchestrator.response_composer import compose_response
from app.orchestrator.runtime import OrchestratorRuntime
from app.orchestrator.supervisor_agent import run_supervisor
from app.orchestrator.types import OrchestratorTurnContext, SupervisorResult
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    base = dict(
        session_id="lat-fix",
        call_sid="CA_LAT",
        from_number="+15551230099",
        to_number="+15559990099",
    )
    base.update(kwargs)
    return SessionState(**base)


@pytest.fixture(autouse=True)
def _reset_postgres_circuit():
    db_connection.reset_postgres_circuit_for_tests()
    db_connection.clear_test_pool()
    yield
    db_connection.reset_postgres_circuit_for_tests()
    db_connection.clear_test_pool()


# ── Phase 1: Postgres circuit breaker ────────────────────────────────────────


@pytest.mark.asyncio
async def test_postgres_refused_opens_circuit_and_skips_writes():
    call_count = 0

    async def _refuse(*_a, **_k):
        nonlocal call_count
        call_count += 1
        raise ConnectionRefusedError("connection refused")

    with patch.object(db_connection, "db_configured", return_value=True):
        with patch.object(db_connection, "get_pool", _refuse):
            await db_connection.execute_write("INSERT INTO x VALUES (1)")
            await db_connection.execute_write("INSERT INTO x VALUES (2)")
            await db_connection.execute_write("INSERT INTO x VALUES (3)")

    assert call_count == 2
    assert not db_connection.postgres_writes_enabled()


@pytest.mark.asyncio
async def test_postgres_circuit_logs_once_during_cooldown(caplog):
    async def _refuse(*_a, **_k):
        raise ConnectionRefusedError("connection refused")

    with patch.object(db_connection, "db_configured", return_value=True):
        with patch.object(db_connection, "get_pool", _refuse):
            with caplog.at_level(logging.WARNING):
                await db_connection.execute_write("INSERT INTO x VALUES (1)")
                await db_connection.execute_write("INSERT INTO x VALUES (2)")
                await db_connection.execute_write("INSERT INTO x VALUES (3)")

    circuit_logs = [r for r in caplog.records if "postgres_circuit_open" in r.message]
    assert len(circuit_logs) == 1
    assert "postgres_write_failed" not in caplog.text


@pytest.mark.asyncio
async def test_postgres_unavailable_does_not_block_live_turn():
    session = _session()
    t0 = time.monotonic()

    async def _refuse(*_a, **_k):
        raise ConnectionRefusedError("connection refused")

    with patch.object(db_connection, "db_configured", return_value=True):
        with patch.object(db_connection, "get_pool", _refuse):
            postgres_store.persist_turn_if_configured(
                session,
                user_text="hello",
                assistant_text="hi",
            )
            await asyncio.sleep(0.02)

    elapsed_ms = (time.monotonic() - t0) * 1000
    assert elapsed_ms < 200


@pytest.mark.asyncio
async def test_strict_postgres_startup_requires_database_url():
    get_settings.cache_clear()
    with patch.dict("os.environ", {"STRICT_POSTGRES": "true", "DATABASE_URL": ""}, clear=False):
        get_settings.cache_clear()
        with pytest.raises(RuntimeError, match="DATABASE_URL"):
            await db_connection.verify_postgres_at_startup()


@pytest.mark.asyncio
async def test_strict_postgres_write_raises(monkeypatch):
    async def _boom(query, *args):
        raise ConnectionError("write failed")

    monkeypatch.setattr(db_connection, "execute_write", _boom)
    monkeypatch.setattr(db_connection, "db_configured", lambda: True)
    monkeypatch.setattr(db_connection, "postgres_writes_enabled", lambda: True)
    with patch("app.config.get_settings") as gs:
        gs.return_value = Settings(
            DATABASE_URL="postgresql://x",
            STRICT_POSTGRES=True,
            APP_ENV="production",
        )
        with pytest.raises(ConnectionError):
            await db_connection.execute_write("SELECT 1")


@pytest.mark.asyncio
async def test_missing_database_url_disables_persistence_at_startup(caplog):
    get_settings.cache_clear()
    with patch.dict("os.environ", {"STRICT_POSTGRES": "false", "DATABASE_URL": ""}, clear=False):
        get_settings.cache_clear()
        with caplog.at_level(logging.WARNING):
            await db_connection.verify_postgres_at_startup()
            await db_connection.verify_postgres_at_startup()
    warn_logs = [r for r in caplog.records if "postgres_not_configured" in r.message]
    assert len(warn_logs) == 1
    assert not db_connection.postgres_writes_enabled()


# ── Phase 2: Smalltalk never calls LLM ───────────────────────────────────────


@pytest.mark.parametrize(
    "utterance",
    ["Hello", "How are you?", "Hello. How are you?", "Hello, how are you?"],
)
@pytest.mark.asyncio
async def test_smalltalk_skips_openai(utterance):
    session = _session()
    with patch(
        "app.orchestrator.supervisor_agent._supervisor_llm",
        new_callable=AsyncMock,
    ) as mock_llm:
        result = await run_supervisor(
            session,
            utterance,
            use_llm=True,
            settings=Settings(OPENAI_API_KEY="test-key"),
        )
        mock_llm.assert_not_called()
    assert result.intent == "smalltalk"
    assert result.confidence >= 0.92


@pytest.mark.parametrize(
    "utterance,expected_fragment",
    [
        ("Hello", "SureShot Books"),
        ("How are you?", "doing well"),
        ("Hello, how are you?", "doing well"),
    ],
)
def test_smalltalk_deterministic_response(utterance, expected_fragment):
    text = resolve_smalltalk_response(utterance)
    assert expected_fragment.lower() in text.lower()


@pytest.mark.asyncio
async def test_smalltalk_runtime_under_200ms_mocked():
    runtime = OrchestratorRuntime(settings=Settings(OPENAI_API_KEY="test-key"))
    session = _session()
    send = AsyncMock()

    with patch(
        "app.orchestrator.supervisor_agent._supervisor_llm",
        new_callable=AsyncMock,
    ) as mock_sup_llm, patch(
        "app.orchestrator.response_composer._compose_llm",
        new_callable=AsyncMock,
    ) as mock_comp_llm, patch(
        "app.orchestrator.runtime.run_planner",
        new_callable=AsyncMock,
    ) as mock_planner:
        t0 = time.monotonic()
        await runtime.handle_turn(session, "Hello. How are you?", send)
        elapsed_ms = (time.monotonic() - t0) * 1000

    mock_sup_llm.assert_not_called()
    mock_comp_llm.assert_not_called()
    mock_planner.assert_not_called()
    assert elapsed_ms < 200
    tokens = [c[0][0].get("token", "") for c in send.await_args_list if c[0][0].get("token")]
    assert any("doing well" in t.lower() for t in tokens)


# ── Phase 3: Incomplete utterances ───────────────────────────────────────────


@pytest.mark.parametrize(
    "utterance",
    ["Can I have", "I want", "Can you find", "I'm looking for"],
)
def test_incomplete_utterance_detected(utterance):
    assert is_incomplete_utterance(utterance)


@pytest.mark.parametrize(
    "utterance",
    ["Can I have", "I want", "Can you find", "I'm looking for"],
)
@pytest.mark.asyncio
async def test_incomplete_utterance_no_openai(utterance):
    session = _session()
    with patch(
        "app.orchestrator.supervisor_agent._supervisor_llm",
        new_callable=AsyncMock,
    ) as mock_llm:
        result = await run_supervisor(
            session,
            utterance,
            use_llm=True,
            settings=Settings(OPENAI_API_KEY="test-key"),
        )
        mock_llm.assert_not_called()
    assert result.clarifying_question
    assert "title or isbn" in result.clarifying_question.lower()


@pytest.mark.asyncio
async def test_incomplete_utterance_runtime_response():
    runtime = OrchestratorRuntime(settings=Settings(OPENAI_API_KEY="test-key"))
    session = _session()
    send = AsyncMock()

    with patch(
        "app.orchestrator.supervisor_agent._supervisor_llm",
        new_callable=AsyncMock,
    ) as mock_llm:
        await runtime.handle_turn(session, "Can I have", send)

    mock_llm.assert_not_called()
    tokens = [c[0][0].get("token", "") for c in send.await_args_list if c[0][0].get("token")]
    assert any("title or isbn" in t.lower() for t in tokens)


# ── Phase 4 & 5: Fast path + latency assertions ──────────────────────────────


@pytest.mark.asyncio
async def test_isbn_fast_path_skips_supervisor_llm():
    session = _session()
    with patch(
        "app.orchestrator.supervisor_agent._supervisor_llm",
        new_callable=AsyncMock,
    ) as mock_llm:
        result = await run_supervisor(
            session,
            "9780441172719",
            use_llm=True,
            settings=Settings(OPENAI_API_KEY="test-key"),
        )
        mock_llm.assert_not_called()
    assert result.intent == "product_search"


def test_smalltalk_classifier():
    assert is_smalltalk("Hello. How are you?")
    assert is_smalltalk("hi")
    assert not is_smalltalk("looking for dune")


@pytest.mark.asyncio
async def test_composer_smalltalk_skips_llm():
    ctx = OrchestratorTurnContext(
        user_text="Hello, how are you?",
        supervisor=SupervisorResult(intent="smalltalk", confidence=0.96),
    )
    with patch(
        "app.orchestrator.response_composer._compose_llm",
        new_callable=AsyncMock,
    ) as mock_llm:
        text = await compose_response(_session(), ctx, use_llm=True)
        mock_llm.assert_not_called()
    assert "doing well" in text.lower()


@pytest.mark.asyncio
async def test_postgres_background_task_not_scheduled_when_circuit_open():
    session = _session()
    db_connection._postgres_cooldown_until = time.monotonic() + 300
    scheduled = []

    def _track(coro):
        scheduled.append(coro)
        coro.close()

    with patch.object(db_connection, "db_configured", return_value=True):
        with patch("app.memory.postgres_store._schedule", side_effect=_track):
            postgres_store.persist_turn_if_configured(
                session,
                user_text="hi",
                assistant_text="hello",
            )

    assert not scheduled
