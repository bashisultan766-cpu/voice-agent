"""Product resolution pipeline — structured lookup, similar hits, support prep."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.agent_runtime.isbn_short_circuit import try_title_catalog_short_circuit
from app.agent_runtime.not_found_escalation_flow import (
    CATALOG_NOT_FOUND_FALLBACK_MESSAGE,
    PRODUCT_SEARCH_FALLBACK_HANDOFF_PROMPT,
    process_not_found_escalation_turn,
    try_product_search_fallback_escalation,
    user_insists_on_purchase,
)
from app.agent_runtime.product_resolution import (
    ProductResolution,
    format_exact_match_reply,
    format_no_exact_reply,
    match_product,
    validate_product_output,
)
from app.agent_runtime.workflow_contracts import WorkflowViolationError
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


def _catalog_hit(**fields) -> dict:
    base = {
        "title": "Sample",
        "variant_id": "v1",
        "price": "10.00",
        "available": True,
        "inventory_quantity": 1,
        "source": "shopify_catalog",
    }
    base.update(fields)
    return base


def test_validate_product_output_requires_catalog_source():
    with pytest.raises(WorkflowViolationError, match="NON_CATALOG_PRODUCT_BLOCKED"):
        validate_product_output({"title": "Ghost Book", "variant_id": "v9"})
    with pytest.raises(WorkflowViolationError, match="NON_CATALOG_PRODUCT_BLOCKED"):
        validate_product_output({"title": "Ghost Book", "source": "shopify_catalog"})
    with pytest.raises(WorkflowViolationError, match="NON_CATALOG_PRODUCT_BLOCKED"):
        validate_product_output({"variant_id": "v9", "source": "shopify_catalog"})
    assert validate_product_output(_catalog_hit())["source"] == "shopify_catalog"


@pytest.mark.asyncio
async def test_isbn_title_fallback_never_becomes_exact_match():
    session = _session()
    title_fallback_payload = {
        "found": True,
        "isbn": "9780143127741",
        "match_type": "title_fallback",
        "confidence": 0.55,
        "needs_confirmation": True,
        "product": {
            "product_id": "gid://shopify/Product/1",
            "variant_id": "gid://shopify/ProductVariant/1",
            "title": "Wrong Guess Book",
            "price": "12.99",
            "available": True,
        },
    }
    with patch(
        "app.tools.shopify_tools.search_product_by_isbn",
        new_callable=AsyncMock,
        return_value=json.dumps(title_fallback_payload),
    ):
        with patch(
            "app.agent_runtime.product_resolution.similarity_engine",
            return_value=[],
        ):
            resolution = await match_product(session, isbn="9780143127741")

    assert resolution.exact is None


@pytest.mark.asyncio
async def test_similar_only_stages_purchase_insistence_fallback():
    session = _session()
    similar = [_catalog_hit(title="Nearby Title", variant_id="v77")]
    resolution = ProductResolution(query="Rare Title", similar=similar)
    from app.agent_runtime.product_resolution import product_resolution_to_short_circuit

    result = await product_resolution_to_short_circuit(
        session,
        "I need Rare Title",
        resolution,
    )
    assert result is not None
    assert session.product_search_fallback_pending.get("escalation_eligible") is True
    assert "Nearby Title" in result.force_reply


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
    similar_hit = _catalog_hit(title="Tiny Habits", variant_id="v2", price="14.00")
    with patch(
        "app.agent_runtime.llm_tools._catalog_search",
        new_callable=AsyncMock,
        return_value=json.dumps(catalog),
    ):
        with patch(
            "app.agent_runtime.product_resolution.similarity_engine",
            return_value=[similar_hit],
        ):
            resolution = await match_product(session, title="Atomic Habits")

    assert resolution.exact is not None
    assert resolution.exact.get("title") == "Atomic Habits"
    assert resolution.exact.get("source") == "shopify_catalog"
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
    similar_hit = _catalog_hit(
        title="A Different Kind of School",
        variant_id="v88",
        price="11.50",
    )
    with patch(
        "app.agent_runtime.llm_tools._catalog_search",
        new_callable=AsyncMock,
        return_value=json.dumps(catalog),
    ):
        with patch(
            "app.agent_runtime.product_resolution.similarity_engine",
            return_value=[similar_hit],
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


@pytest.mark.asyncio
async def test_no_exact_without_similar_triggers_support_handoff():
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
    assert CATALOG_NOT_FOUND_FALLBACK_MESSAGE in result.force_reply
    assert result.catalog_not_found_escalation is True
    assert session.awaiting_not_found_escalation_email is True
    assert session.pending_not_found_escalation.get("reason") == "product_not_found"


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


def test_format_no_exact_without_alternatives_raises():
    with pytest.raises(WorkflowViolationError, match="NON_CATALOG_PRODUCT_BLOCKED"):
        format_no_exact_reply(ProductResolution(query="Rare Title XYZ"))


def test_format_no_exact_requires_catalog_similar_hits():
    similar = [_catalog_hit(title="Nearby Title", variant_id="v77")]
    msg = format_no_exact_reply(
        ProductResolution(query="Rare Title XYZ", similar=similar),
    )
    assert "couldn't find the exact product" in msg.lower()
    assert "Nearby Title" in msg
