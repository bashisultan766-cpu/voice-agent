"""Order lookup must return the exact order the caller spoke — no fuzzy Shopify matches."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest

from app.agent_runtime.order_flow_state import try_order_enrichment_short_circuit
from app.state.models import SessionState
from app.tests.test_isbn_and_order_lookup_fix import _MOCK_ORDER_NODE


def _session(**kwargs) -> SessionState:
    session = SessionState(
        session_id="ord_exact",
        call_sid="CAORD001",
        from_number="+1",
        to_number="+2",
    )
    for key, value in kwargs.items():
        setattr(session, key, value)
    return session


@pytest.mark.asyncio
async def test_shopify_fuzzy_match_rejected():
    wrong = {**_MOCK_ORDER_NODE, "name": "#99999"}
    client = AsyncMock()
    client.configured = True
    client.execute = AsyncMock(
        return_value={"data": {"orders": {"edges": [{"node": wrong}]}}},
    )

    with patch("app.tools.shopify_tools.get_shopify_client", return_value=client):
        with patch("app.tools.shopify_tools.shopify_cache_get", AsyncMock(return_value=None)):
            with patch("app.tools.shopify_tools.shopify_cache_set", AsyncMock()):
                from app.tools.shopify_tools import lookup_shopify_order_details

                raw = await lookup_shopify_order_details("1009")

    data = json.loads(raw)
    assert data.get("found") is False
    assert data.get("error_code") == "order_not_found"


@pytest.mark.asyncio
async def test_shopify_exact_match_accepted():
    right = {**_MOCK_ORDER_NODE, "name": "#1009"}
    client = AsyncMock()
    client.configured = True
    client.execute = AsyncMock(
        return_value={"data": {"orders": {"edges": [{"node": right}]}}},
    )

    with patch("app.tools.shopify_tools.get_shopify_client", return_value=client):
        with patch("app.tools.shopify_tools.shopify_cache_get", AsyncMock(return_value=None)):
            with patch("app.tools.shopify_tools.shopify_cache_set", AsyncMock()):
                with patch(
                    "app.tools.shopify_tools._fetch_order_timeline",
                    AsyncMock(return_value=[]),
                ):
                    from app.tools.shopify_tools import lookup_shopify_order_details

                    raw = await lookup_shopify_order_details("1009")

    data = json.loads(raw)
    assert data.get("found") is True
    assert data["order"]["order_number"] in ("#1009", "1009")


@pytest.mark.asyncio
async def test_new_order_number_clears_stale_cache():
    session = _session(
        last_order_number="99999",
        order_last_voice_reply="Stale wrong order summary.",
        order_context='{"order_number":"#99999"}',
    )
    with patch(
        "app.agent_runtime.order_parallel_enrichment.enrich_order_parallel",
        new_callable=AsyncMock,
    ) as mock_enrich:
        from app.agent_runtime.order_parallel_enrichment import OrderEnrichmentResult

        mock_enrich.return_value = OrderEnrichmentResult(
            order_number="47905",
            order={"found": True, "order": {"order_number": "#47905"}},
            suggested_response="I found your order for 47905.",
        )
        hint = await try_order_enrichment_short_circuit(
            session, "My order number is 4 7 9 0 5.",
        )

    assert hint and hint.force_reply
    assert session.order_last_voice_reply == ""
    mock_enrich.assert_awaited_once()
