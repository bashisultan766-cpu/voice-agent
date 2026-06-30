"""Product resolution pipeline — structured lookup, similar hits, support prep."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.agent_runtime.isbn_short_circuit import try_title_catalog_short_circuit
from app.agent_runtime.not_found_escalation_flow import (
    PRODUCT_SEARCH_FALLBACK_HANDOFF_PROMPT,
    process_not_found_escalation_turn,
    try_product_search_fallback_escalation,
    user_insists_on_purchase,
)
from app.agent_runtime.product_resolution import (
    format_exact_match_reply,
    format_no_exact_reply,
    match_product,
)
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    base = dict(
        session_id="s",
        call_sid="CA_RES",
        from_number="+1",
        to_number="+2",
    )
    base.update(kwargs)
    return SessionState(**base)


@pytest.mark.asyncio
async def test_match_product_exact_includes_similar():
    session = _session()
    catalog = {
        "results": [
            {
                "title": "Atomic Habits",
                "variant_id": "v1",
                "price": "16.00",
                "available": True,
                "inventory_quantity": 5,
            },
            {
                "title": "Tiny Habits",
                "variant_id": "v2",
                "price": "14.00",
                "available": True,
                "inventory_quantity": 3,
            },
        ],
        "count": 2,
    }
    with patch(
        "app.agent_runtime.llm_tools._catalog_search",
        new_callable=AsyncMock,
        return_value=json.dumps(catalog),
    ):
        resolution = await match_product(session, title="Atomic Habits")

    assert resolution.exact is not None
    assert resolution.exact.get("title") == "Atomic Habits"
    assert len(resolution.similar) >= 1
    reply = format_exact_match_reply(resolution)
    assert "Atomic Habits" in reply
    assert "Similar options" in reply


@pytest.mark.asyncio
async def test_no_exact_with_similar_offers_alternatives_without_handoff():
    session = _session()
    catalog = {
        "results": [{
            "title": "A Different Kind of School",
            "variant_id": "v88",
            "price": "11.50",
            "available": True,
            "inventory_quantity": 3,
        }],
        "count": 1,
    }
    with patch(
        "app.agent_runtime.llm_tools._catalog_search",
        new_callable=AsyncMock,
        return_value=json.dumps(catalog),
    ):
        result = await try_title_catalog_short_circuit(
            session,
            "I'm looking for Gurdwara",
        )

    assert result is not None
    assert "couldn't find the exact product" in result.force_reply.lower()
    assert "different kind of school" in result.force_reply.lower()
    assert "support team will check availability" not in result.force_reply.lower()
    assert session.awaiting_not_found_escalation_email is False
    pending = session.product_search_fallback_pending
    assert pending.get("escalation_eligible") is False


@pytest.mark.asyncio
async def test_no_exact_without_similar_waits_for_insistence():
    session = _session()
    with patch(
        "app.agent_runtime.llm_tools._catalog_search",
        new_callable=AsyncMock,
        return_value=json.dumps({"results": [], "count": 0}),
    ):
        with patch(
            "app.agent_runtime.product_resolution.similarity_engine",
            return_value=[],
        ):
            result = await try_title_catalog_short_circuit(
                session,
                "I'm looking for Rare Book XYZ-999",
            )

    assert result is not None
    assert "couldn't find the exact product" in result.force_reply.lower()
    assert session.awaiting_not_found_escalation_email is False
    assert session.product_search_fallback_pending.get("escalation_eligible") is True


@pytest.mark.asyncio
async def test_fallback_escalation_after_purchase_insistence():
    session = _session()
    session.product_search_fallback_pending = {
        "query": "Rare Book XYZ-999",
        "escalation_eligible": True,
    }
    assert user_insists_on_purchase("I still need to buy that book")

    reply = try_product_search_fallback_escalation(
        session,
        "I still need to buy that book please",
    )

    assert reply == PRODUCT_SEARCH_FALLBACK_HANDOFF_PROMPT
    assert session.awaiting_not_found_escalation_email is True
    assert session.product_search_fallback_pending == {}


@pytest.mark.asyncio
async def test_product_handoff_email_capture_is_silent():
    session = _session(awaiting_not_found_escalation_email=True)
    session.pending_not_found_escalation = {
        "reason": "product_not_found",
        "email_capture_mode": "silent",
        "customer_name": "Alex",
        "session_id": "s",
        "call_sid": "CA",
        "query_type": "title",
        "issue_title": "Not found",
        "issue_detail": "No match",
    }
    mock_client = MagicMock()
    mock_client.post = AsyncMock(return_value=MagicMock(status_code=200))
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch("app.escalation.support_handoff.get_settings") as mock_settings:
        mock_settings.return_value = MagicMock(
            SUPPORT_EMAIL="support@test.com",
            RESEND_API_KEY="re_test",
            SUPPORT_ESCALATION_ENABLED=True,
        )
        with patch("app.escalation.support_handoff.httpx.AsyncClient", return_value=mock_client):
            with patch(
                "app.escalation.conversation_summarizer.analyze_conversation_for_support",
                new_callable=AsyncMock,
                return_value=({"issue_summary": "x", "user_intent": "y", "unresolved_needs": "z", "urgency_level": "low"}, ""),
            ):
                hint = await process_not_found_escalation_turn(
                    session,
                    "john smith at gmail dot com",
                )
    assert hint.force_reply
    assert "letter by letter" not in hint.force_reply.lower()
    assert "@" not in hint.force_reply
    assert "gmail" not in hint.force_reply.lower()


def test_format_no_exact_without_alternatives():
    from app.agent_runtime.product_resolution import ProductResolution

    msg = format_no_exact_reply(ProductResolution(query="Rare Title XYZ"))
    assert "couldn't find the exact product" in msg.lower()
