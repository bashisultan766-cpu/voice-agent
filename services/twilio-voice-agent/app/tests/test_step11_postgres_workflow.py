"""
Step 11 — Postgres persistence and workflow replay tests.
"""
from __future__ import annotations

import asyncio
import json
import os
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.db import connection as db_connection
from app.db.pii_masking import mask_email, mask_payment_url, mask_phone, mask_payload
from app.main import create_app
from app.state.models import SessionState
from app.workflow.event_store import (
    get_session_timeline,
    get_turn_events,
    record_workflow_event,
    replay_session,
)


@pytest.fixture
def session_state() -> SessionState:
    return SessionState(
        session_id="sess-test-001",
        call_sid="CA1234567890",
        from_number="+14155551234",
        to_number="+18005551234",
    )


@pytest.fixture
def captured_writes():
    return []


@pytest.fixture
def mock_db_writes(monkeypatch, captured_writes):
    async def _execute_write(query: str, *args):
        captured_writes.append({"query": query, "args": args})

    monkeypatch.setattr(db_connection, "execute_write", _execute_write)
    monkeypatch.setattr(db_connection, "db_configured", lambda: True)
    return captured_writes


@pytest.fixture
def workflow_rows():
    rows: list[dict] = []
    return rows


@pytest.fixture
def mock_db_reads(monkeypatch, workflow_rows):
    async def _fetch_rows(query: str, *args):
        if "workflow_events" in query and "turn_id = $2" in query:
            turn_id = args[1]
            filtered = [r for r in workflow_rows if r.get("turn_id") == turn_id]
            return sorted(filtered, key=lambda r: (r.get("created_at"), r.get("id", 0)))
        if "workflow_events" in query:
            session_id = args[0]
            filtered = [r for r in workflow_rows if r.get("session_id") == session_id]
            return sorted(filtered, key=lambda r: (r.get("created_at"), r.get("id", 0)))
        if "call_sessions" in query:
            return [{"id": args[0], "call_sid": "CA123", "phone_masked": "***1234", "status": "ended"}]
        if "tool_events" in query:
            return []
        return []

    monkeypatch.setattr(db_connection, "fetch_rows", _fetch_rows)
    monkeypatch.setattr(db_connection, "db_configured", lambda: True)

    async def _execute_write(query: str, *args):
        if "workflow_events" in query:
            workflow_rows.append(
                {
                    "id": len(workflow_rows) + 1,
                    "session_id": args[0],
                    "turn_id": args[1],
                    "event_type": args[2],
                    "payload_masked": args[3],
                    "created_at": f"2026-06-26T12:00:{len(workflow_rows):02d}Z",
                }
            )

    monkeypatch.setattr(db_connection, "execute_write", _execute_write)
    return workflow_rows


# ── 1–3. Masking ─────────────────────────────────────────────────────────────


def test_postgres_store_masks_email():
    assert mask_email("alice@example.com") == "a***e@example.com"
    masked = mask_payload({"email": "bob@test.org", "note": "reach bob@test.org"})
    assert "bob@test.org" not in json.dumps(masked)
    assert "@test.org" in json.dumps(masked)


def test_postgres_store_masks_phone():
    assert mask_phone("+14155551234") == "***1234"
    masked = mask_payload({"caller_phone": "+14155559999", "reason": "callback"})
    assert "9999" in json.dumps(masked)
    assert "+14155559999" not in json.dumps(masked)


def test_postgres_store_masks_payment_url():
    url = "https://checkout.shopify.com/carts/abc123?key=secret_token"
    masked = mask_payment_url(url)
    assert "secret_token" not in masked
    assert "checkout" in masked or "***" in masked
    payload = mask_payload({"checkout_url": url})
    assert "secret_token" not in json.dumps(payload)


# ── 4–6. Workflow events ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_workflow_event_recorded(mock_db_writes, session_state):
    await record_workflow_event(
        session_state.session_id,
        "turn-abc",
        "supervisor_result",
        {"intent": "product_search", "email": "hide@secret.com"},
        session=session_state,
    )
    assert any("workflow_events" in w["query"] for w in mock_db_writes)
    wf = [w for w in mock_db_writes if "workflow_events" in w["query"]][0]
    assert wf["args"][2] == "supervisor_result"
    assert "hide@secret.com" not in wf["args"][3]


@pytest.mark.asyncio
async def test_session_timeline_returned_in_order(mock_db_reads):
    sid = "sess-order"
    await record_workflow_event(sid, "t1", "call_started", {})
    await record_workflow_event(sid, "t1", "user_turn_received", {})
    await record_workflow_event(sid, "t1", "response_sent", {})
    timeline = await get_session_timeline(sid)
    types = [e["event_type"] for e in timeline]
    assert types == ["call_started", "user_turn_received", "response_sent"]


@pytest.mark.asyncio
async def test_replay_excludes_secrets(mock_db_reads):
    sid = "sess-replay"
    await record_workflow_event(
        sid,
        "t1",
        "tool_succeeded",
        {"api_key": "sk-live-secret", "confirmed_email": "real@user.com", "tool": "search"},
    )
    replay = await replay_session(sid)
    blob = json.dumps(replay)
    assert "sk-live-secret" not in blob
    assert "real@user.com" not in blob
    assert "search" in blob


@pytest.mark.asyncio
async def test_turn_events_filter(mock_db_reads):
    sid = "sess-turn"
    await record_workflow_event(sid, "t1", "user_turn_received", {})
    await record_workflow_event(sid, "t2", "user_turn_received", {})
    events = await get_turn_events(sid, "t1")
    assert len(events) == 1
    assert events[0]["turn_id"] == "t1"


# ── 7–8. Admin endpoints ─────────────────────────────────────────────────────


def test_admin_endpoint_requires_key():
    app = create_app()
    get_settings.cache_clear()
    with patch.dict(
        os.environ,
        {
            "ENABLE_ADMIN_DEBUG_ENDPOINTS": "true",
            "INTERNAL_ADMIN_KEY": "test-admin-key",
            "APP_ENV": "test",
        },
        clear=False,
    ):
        get_settings.cache_clear()
        client = TestClient(app)
        r = client.get("/admin/sessions/sess-1/timeline")
        assert r.status_code == 403
        r2 = client.get(
            "/admin/sessions/sess-1/timeline",
            headers={"X-Admin-Key": "test-admin-key"},
        )
        assert r2.status_code == 200


def test_admin_endpoint_disabled_by_default():
    app = create_app()
    get_settings.cache_clear()
    with patch.dict(
        os.environ,
        {
            "ENABLE_ADMIN_DEBUG_ENDPOINTS": "false",
            "INTERNAL_ADMIN_KEY": "test-admin-key",
            "APP_ENV": "test",
        },
        clear=False,
    ):
        get_settings.cache_clear()
        client = TestClient(app)
        r = client.get(
            "/admin/sessions/sess-1/timeline",
            headers={"X-Admin-Key": "test-admin-key"},
        )
        assert r.status_code == 404


# ── 9–11. Persistence hooks ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_tool_events_persist(mock_db_writes, session_state):
    from app.memory.postgres_store import persist_tool_event_if_configured

    persist_tool_event_if_configured(
        session_state,
        tool_name="search_products",
        success=True,
        latency_ms=42.0,
        turn_id="turn-1",
        input_data={"query": "ISBN 978123", "email": "x@y.com"},
        output_data={"success": True, "checkout_url": "https://pay.shopify.com/x?token=abc"},
    )
    await asyncio.sleep(0.05)
    tool_writes = [w for w in mock_db_writes if "tool_events" in w["query"]]
    assert len(tool_writes) >= 1
    args = tool_writes[0]["args"]
    blob = json.dumps(args)
    assert "x@y.com" not in blob
    assert "token=abc" not in blob


@pytest.mark.asyncio
async def test_escalation_event_persists(mock_db_writes, session_state):
    from app.memory.postgres_store import persist_escalation_if_configured

    persist_escalation_if_configured(
        session_state,
        escalation_type="human_escalation",
        payload={"reason": "angry", "phone": "+19998887777"},
    )
    await asyncio.sleep(0.05)
    esc = [w for w in mock_db_writes if "escalations" in w["query"]]
    assert len(esc) >= 1
    assert "+19998887777" not in json.dumps(esc[0]["args"])


@pytest.mark.asyncio
async def test_payment_link_event_persists(mock_db_writes, session_state):
    from app.memory.postgres_store import persist_payment_link_if_configured

    persist_payment_link_if_configured(
        session_state,
        email="payme@example.com",
        checkout_url="https://checkout.shopify.com/c/abc?key=secret",
        draft_order_id="draft-99",
    )
    await asyncio.sleep(0.05)
    pl = [w for w in mock_db_writes if "payment_links" in w["query"]]
    assert len(pl) >= 1
    blob = json.dumps(pl[0]["args"])
    assert "payme@example.com" not in blob
    assert "secret" not in blob


# ── 12–13. Failure modes ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_postgres_failure_does_not_break_dev_call(session_state):
    from app.memory import postgres_store

    async def _boom(*_a, **_k):
        raise ConnectionError("db down")

    with patch.object(db_connection, "db_configured", return_value=True):
        with patch.object(db_connection, "execute_write", _boom):
            with patch("app.config.get_settings") as gs:
                gs.return_value = Settings(
                    DATABASE_URL="postgresql://x",
                    STRICT_POSTGRES=False,
                    APP_ENV="development",
                )
                postgres_store.persist_turn_if_configured(
                    session_state,
                    user_text="hello",
                    assistant_text="hi there",
                )
                await asyncio.sleep(0.05)


@pytest.mark.asyncio
async def test_strict_postgres_startup_requires_database_url():
    get_settings.cache_clear()
    with patch.dict(os.environ, {"STRICT_POSTGRES": "true", "DATABASE_URL": ""}, clear=False):
        get_settings.cache_clear()
        with pytest.raises(RuntimeError, match="DATABASE_URL"):
            await db_connection.verify_postgres_at_startup()


@pytest.mark.asyncio
async def test_strict_postgres_write_raises(monkeypatch):
    async def _boom(query, *args):
        raise ConnectionError("write failed")

    monkeypatch.setattr(db_connection, "execute_write", _boom)
    monkeypatch.setattr(db_connection, "db_configured", lambda: True)
    with patch("app.config.get_settings") as gs:
        gs.return_value = Settings(
            DATABASE_URL="postgresql://x",
            STRICT_POSTGRES=True,
            APP_ENV="production",
        )
        with pytest.raises(ConnectionError):
            await db_connection.execute_write("SELECT 1")
