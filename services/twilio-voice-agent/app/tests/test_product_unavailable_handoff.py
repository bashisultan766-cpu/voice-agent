"""Product not found / out-of-stock → support handoff with name+email capture."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest

from app.agent_runtime.commerce_flow_state import (
    STATUS_AWAITING_QUANTITY,
    process_commerce_turn,
    stage_product_candidate,
)
from app.agent_runtime.isbn_short_circuit import (
    try_isbn_short_circuit,
    try_title_catalog_short_circuit,
)
from app.escalation.product_not_found_escalation import _STORE
from app.state.models import SessionState

TEST_ISBN = "9780143127741"


def _session(**kwargs) -> SessionState:
    base = dict(
        session_id="sess_oos_001",
        call_sid="CA_OOS001",
        from_number="+15551234001",
        to_number="+15559994001",
        caller_name="Alex Rivera",
    )
    base.update(kwargs)
    return SessionState(**base)


@pytest.fixture(autouse=True)
def _clear_escalation_store():
    from app.escalation import product_not_found_escalation as pne

    _STORE.clear()
    pne._SYNC_REDIS = None
    with patch.object(pne, "_get_sync_redis", return_value=None):
        yield
    _STORE.clear()
    pne._SYNC_REDIS = None


@pytest.mark.asyncio
async def test_isbn_not_found_starts_support_handoff():
    session = _session()
    not_found_payload = {
        "found": False,
        "isbn": TEST_ISBN,
        "normalized_isbn": TEST_ISBN,
        "match_type": "none",
        "confidence": 0.0,
        "product": None,
    }
    with patch(
        "app.tools.shopify_tools.search_product_by_isbn",
        new_callable=AsyncMock,
        return_value=json.dumps(not_found_payload),
    ):
        result = await try_isbn_short_circuit(session, TEST_ISBN, turn_mode="isbn")

    assert result is not None
    assert "name and email" in result.force_reply.lower()
    assert "support team" in result.force_reply.lower()
    assert session.awaiting_not_found_escalation_email is True
    assert session.pending_not_found_escalation.get("reason") == "product_not_found"


@pytest.mark.asyncio
async def test_isbn_out_of_stock_starts_support_handoff():
    session = _session()
    oos_payload = {
        "found": True,
        "isbn": TEST_ISBN,
        "normalized_isbn": TEST_ISBN,
        "match_type": "barcode",
        "confidence": 1.0,
        "product": {
            "product_id": "gid://shopify/Product/1",
            "variant_id": "gid://shopify/ProductVariant/1",
            "title": "Sample Book",
            "author": "Author Name",
            "price": "12.99",
            "available": False,
            "inventory_quantity": 0,
        },
    }
    with patch(
        "app.tools.shopify_tools.search_product_by_isbn",
        new_callable=AsyncMock,
        return_value=json.dumps(oos_payload),
    ):
        result = await try_isbn_short_circuit(session, TEST_ISBN, turn_mode="isbn")

    assert result is not None
    assert "name and email" in result.force_reply.lower()
    assert session.awaiting_not_found_escalation_email is True
    assert session.pending_not_found_escalation.get("reason") == "product_out_of_stock"
    assert session.commerce_flow_status == "idle"


@pytest.mark.asyncio
async def test_title_not_found_starts_support_handoff():
    session = _session()
    empty_catalog = json.dumps({"results": [], "count": 0})
    with patch(
        "app.agent_runtime.llm_tools._catalog_search",
        new_callable=AsyncMock,
        return_value=empty_catalog,
    ):
        result = await try_title_catalog_short_circuit(
            session,
            "I need the Sunday Times newspaper subscription for Texas",
            turn_mode="",
        )

    assert result is not None
    assert "name and email" in result.force_reply.lower()
    assert session.awaiting_not_found_escalation_email is True


def test_commerce_oos_utterance_triggers_handoff():
    session = _session(commerce_flow_status=STATUS_AWAITING_QUANTITY)
    stage_product_candidate(session, {
        "variant_id": "gid://shopify/ProductVariant/99",
        "title": "Rare Magazine Issue",
        "price": "8.00",
        "available": True,
    })
    hint = process_commerce_turn(session, "Okay, it is out of stock.")

    assert hint.force_reply
    assert "name and email" in hint.force_reply.lower()
    assert session.awaiting_not_found_escalation_email is True
