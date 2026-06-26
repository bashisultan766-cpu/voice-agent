"""
Step 5 — product-not-found escalation workflow tests.
"""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.agent_runtime.not_found_escalation_flow import (
    build_escalation_payload,
    handle_search_not_found_results,
    infer_requested_type,
    is_search_not_found,
    process_not_found_escalation_turn,
)
from app.config import Settings
from app.escalation.models import ProductNotFoundEscalationPayload
from app.escalation.product_not_found_escalation import (
    _STORE,
    create_product_not_found_escalation,
)
from app.orchestrator.response_composer import _deterministic_from_tools
from app.orchestrator.types import (
    OrchestratorTurnContext,
    PlannerResult,
    PlanStep,
    SupervisorResult,
    ToolExecutionResult,
)
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    base = dict(
        session_id="sess_nf_001",
        call_sid="CA_NF001",
        from_number="+15551234001",
        to_number="+15559994001",
    )
    base.update(kwargs)
    return SessionState(**base)


def _not_found_search_result() -> dict:
    return {"results": [], "count": 0, "not_found": True}


def _found_search_result(title: str = "Test Book") -> dict:
    return {
        "results": [{"title": title, "price": "12.99"}],
        "count": 1,
        "not_found": False,
    }


@pytest.fixture(autouse=True)
def _clear_escalation_store():
    _STORE.clear()
    yield
    _STORE.clear()


class TestInferRequestedType:
    def test_isbn(self):
        assert infer_requested_type("find isbn 9781234567890", "9781234567890") == "isbn"

    def test_newspaper(self):
        assert infer_requested_type("Do you have the Wall Street newspaper?", "Wall Street") == "newspaper"

    def test_magazine(self):
        assert infer_requested_type("I need a magazine called Reader", "Reader") == "magazine"

    def test_title(self):
        assert infer_requested_type("looking for The Great Gatsby", "The Great Gatsby") == "title"


class TestIsSearchNotFound:
    def test_empty_results(self):
        assert is_search_not_found(_not_found_search_result()) is True

    def test_found(self):
        assert is_search_not_found(_found_search_result()) is False

    def test_partial_isbn_not_not_found(self):
        assert is_search_not_found({"needs_more_digits": True, "count": 0}) is False


class TestCreateProductNotFoundEscalation:
    @pytest.mark.asyncio
    async def test_missing_email_asks_customer(self):
        settings = Settings(
            SUPPORT_EMAIL="support@sureshotbooks.com",
            RESEND_API_KEY="re_test",
            SUPPORT_ESCALATION_ENABLED=True,
        )
        payload = ProductNotFoundEscalationPayload(
            session_id="sess1",
            call_sid="CA1",
            customer_phone="+15551234001",
            requested_type="isbn",
            requested_value="9781234567890",
            customer_email="",
        )
        with patch("app.escalation.product_not_found_escalation.get_settings", return_value=settings):
            raw = await create_product_not_found_escalation(payload)
        data = json.loads(raw)
        assert data["success"] is False
        assert data["error_code"] == "missing_customer_email"
        assert "email" in data["customer_message"].lower()

    @pytest.mark.asyncio
    async def test_sends_support_email_with_details(self):
        settings = Settings(
            SUPPORT_EMAIL="jessica@sureshotbooks.com",
            RESEND_API_KEY="re_test",
            SUPPORT_ESCALATION_FROM_EMAIL="Voice Agent <noreply@sureshotbooks.com>",
            SUPPORT_ESCALATION_ENABLED=True,
        )
        payload = ProductNotFoundEscalationPayload(
            session_id="sess_nf_001",
            call_sid="CA_NF001",
            customer_phone="+15551234001",
            customer_name="Jane",
            customer_email="jane@example.com",
            requested_type="isbn",
            requested_value="9781234567890",
            conversation_summary="Customer asked for ISBN",
        )
        mock_resp = MagicMock()
        mock_resp.status_code = 200

        with patch("app.escalation.product_not_found_escalation.get_settings", return_value=settings):
            with patch("httpx.AsyncClient") as mock_client_cls:
                mock_client = AsyncMock()
                mock_client.post = AsyncMock(return_value=mock_resp)
                mock_client.__aenter__ = AsyncMock(return_value=mock_client)
                mock_client.__aexit__ = AsyncMock(return_value=False)
                mock_client_cls.return_value = mock_client

                raw = await create_product_not_found_escalation(payload)

        data = json.loads(raw)
        assert data["success"] is True
        assert data["escalation_id"]
        assert "forward this to our team" in data["customer_message"].lower()

        sent = mock_client.post.call_args
        email_json = sent.kwargs.get("json") or sent[1].get("json")
        assert email_json["to"] == ["jessica@sureshotbooks.com"]
        body = email_json["text"]
        assert "9781234567890" in body
        assert "CA_NF001" in body
        assert "sess_nf_001" in body
        assert "jane@example.com" in body

    @pytest.mark.asyncio
    async def test_idempotent_duplicate(self):
        settings = Settings(
            SUPPORT_EMAIL="support@sureshotbooks.com",
            RESEND_API_KEY="re_test",
            SUPPORT_ESCALATION_ENABLED=True,
        )
        payload = ProductNotFoundEscalationPayload(
            session_id="sess1",
            call_sid="CA1",
            customer_email="a@example.com",
            requested_type="title",
            requested_value="Rare Book Title",
        )
        mock_resp = MagicMock()
        mock_resp.status_code = 200

        with patch("app.escalation.product_not_found_escalation.get_settings", return_value=settings):
            with patch("httpx.AsyncClient") as mock_client_cls:
                mock_client = AsyncMock()
                mock_client.post = AsyncMock(return_value=mock_resp)
                mock_client.__aenter__ = AsyncMock(return_value=mock_client)
                mock_client.__aexit__ = AsyncMock(return_value=False)
                mock_client_cls.return_value = mock_client

                first = json.loads(await create_product_not_found_escalation(payload))
                second = json.loads(await create_product_not_found_escalation(payload))

        assert first["success"] is True
        assert second["success"] is True
        assert second.get("idempotent") is True
        assert mock_client.post.await_count == 1


class TestOrchestratorNotFoundFlow:
    @pytest.mark.asyncio
    async def test_isbn_not_found_asks_for_email(self):
        session = _session()
        ctx = OrchestratorTurnContext(
            user_text="find isbn 9789999999999",
            supervisor=SupervisorResult(intent="product_search"),
            planner=PlannerResult(
                steps=[PlanStep(tool="search_products", args={"query": "9789999999999"})],
            ),
            tool_results=[
                ToolExecutionResult(
                    tool="search_products",
                    success=True,
                    result=_not_found_search_result(),
                ),
            ],
        )
        hint = await handle_search_not_found_results(session, ctx)
        assert hint.force_reply
        assert "email" in hint.force_reply.lower()
        assert session.awaiting_not_found_escalation_email is True

    @pytest.mark.asyncio
    async def test_title_not_found_asks_for_email(self):
        session = _session()
        ctx = OrchestratorTurnContext(
            user_text="The Great Gatsby",
            supervisor=SupervisorResult(intent="product_search"),
            planner=PlannerResult(
                steps=[PlanStep(tool="search_products", args={"query": "The Great Gatsby"})],
            ),
            tool_results=[
                ToolExecutionResult(
                    tool="search_products",
                    success=True,
                    result=_not_found_search_result(),
                ),
            ],
        )
        hint = await handle_search_not_found_results(session, ctx)
        assert "not showing as available" in hint.force_reply.lower()

    @pytest.mark.asyncio
    async def test_magazine_not_found(self):
        session = _session()
        ctx = OrchestratorTurnContext(
            user_text="Do you have Reader magazine",
            supervisor=SupervisorResult(intent="product_search"),
            planner=PlannerResult(
                steps=[PlanStep(tool="search_products", args={"query": "Reader magazine"})],
            ),
            tool_results=[
                ToolExecutionResult(
                    tool="search_products",
                    success=True,
                    result=_not_found_search_result(),
                ),
            ],
        )
        hint = await handle_search_not_found_results(session, ctx)
        pending = session.pending_not_found_escalation
        assert pending.get("requested_type") == "magazine"

    @pytest.mark.asyncio
    async def test_newspaper_not_found(self):
        session = _session()
        ctx = OrchestratorTurnContext(
            user_text="I need the Times newspaper",
            supervisor=SupervisorResult(intent="product_search"),
            planner=PlannerResult(
                steps=[PlanStep(tool="search_products", args={"query": "Times newspaper"})],
            ),
            tool_results=[
                ToolExecutionResult(
                    tool="search_products",
                    success=True,
                    result=_not_found_search_result(),
                ),
            ],
        )
        hint = await handle_search_not_found_results(session, ctx)
        assert session.pending_not_found_escalation.get("requested_type") == "newspaper"
        assert hint.force_reply

    @pytest.mark.asyncio
    async def test_confirmed_email_sends_escalation(self):
        session = _session(confirmed_email="buyer@example.com")
        ctx = OrchestratorTurnContext(
            user_text="9789999999999",
            supervisor=SupervisorResult(intent="product_search"),
            planner=PlannerResult(
                steps=[PlanStep(tool="search_products", args={"query": "9789999999999"})],
            ),
            tool_results=[
                ToolExecutionResult(
                    tool="search_products",
                    success=True,
                    result=_not_found_search_result(),
                ),
            ],
        )
        settings = Settings(
            SUPPORT_EMAIL="support@sureshotbooks.com",
            RESEND_API_KEY="re_test",
            SUPPORT_ESCALATION_ENABLED=True,
        )
        mock_resp = MagicMock()
        mock_resp.status_code = 200

        with patch("app.escalation.product_not_found_escalation.get_settings", return_value=settings):
            with patch("httpx.AsyncClient") as mock_client_cls:
                mock_client = AsyncMock()
                mock_client.post = AsyncMock(return_value=mock_resp)
                mock_client.__aenter__ = AsyncMock(return_value=mock_client)
                mock_client.__aexit__ = AsyncMock(return_value=False)
                mock_client_cls.return_value = mock_client

                hint = await handle_search_not_found_results(session, ctx, settings=settings)

        assert hint.extra_tool_result is not None
        assert hint.extra_tool_result.success is True
        assert "forward this to our team" in hint.force_reply.lower()
        mock_client.post.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_email_on_followup_turn_sends_escalation(self):
        session = _session()
        session.awaiting_not_found_escalation_email = True
        session.pending_not_found_escalation = build_escalation_payload(
            session,
            user_text="9789999999999",
            query="9789999999999",
            search_result=_not_found_search_result(),
        ).to_dict()

        settings = Settings(
            SUPPORT_EMAIL="support@sureshotbooks.com",
            RESEND_API_KEY="re_test",
            SUPPORT_ESCALATION_ENABLED=True,
        )
        mock_resp = MagicMock()
        mock_resp.status_code = 200

        with patch("app.escalation.product_not_found_escalation.get_settings", return_value=settings):
            with patch("httpx.AsyncClient") as mock_client_cls:
                mock_client = AsyncMock()
                mock_client.post = AsyncMock(return_value=mock_resp)
                mock_client.__aenter__ = AsyncMock(return_value=mock_client)
                mock_client.__aexit__ = AsyncMock(return_value=False)
                mock_client_cls.return_value = mock_client

                hint = await process_not_found_escalation_turn(
                    session, "my email is buyer@example.com"
                )

        assert hint.force_reply
        assert hint.extra_tool_result and hint.extra_tool_result.success
        assert session.awaiting_not_found_escalation_email is False

    def test_product_found_does_not_trigger_escalation_message(self):
        results = [
            ToolExecutionResult(
                tool="search_products",
                success=True,
                result=_found_search_result("Found Book"),
            ),
        ]
        msg = _deterministic_from_tools(
            results, SupervisorResult(intent="product_search"), _session()
        )
        assert "add it to your cart" in msg.lower()
        assert "forward" not in msg.lower()


class TestProductionConfig:
    def test_support_email_required_in_production_when_escalation_enabled(self):
        s = Settings(
            APP_ENV="production",
            OPENAI_API_KEY="sk-test",
            TWILIO_ACCOUNT_SID="AC123",
            TWILIO_AUTH_TOKEN="tok",
            REDIS_URL="redis://127.0.0.1:6379",
            SUPPORT_ESCALATION_ENABLED=True,
            SUPPORT_EMAIL="",
            DEBUG=False,
        )
        with pytest.raises(RuntimeError, match="SUPPORT_EMAIL"):
            s.validate_production()

    def test_support_email_not_required_when_escalation_disabled(self):
        s = Settings(
            APP_ENV="production",
            OPENAI_API_KEY="sk-test",
            TWILIO_ACCOUNT_SID="AC123",
            TWILIO_AUTH_TOKEN="tok",
            REDIS_URL="redis://127.0.0.1:6379",
            SUPPORT_ESCALATION_ENABLED=False,
            SUPPORT_EMAIL="",
            DEBUG=False,
        )
        s.validate_production()

    def test_defaults(self):
        s = Settings()
        assert s.SUPPORT_ESCALATION_ENABLED is True
