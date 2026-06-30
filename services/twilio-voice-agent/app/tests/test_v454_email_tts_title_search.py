"""v4.56 — paced email TTS delivery + explicit-title catalog search."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest

from app.agent_runtime.isbn_short_circuit import (
    extract_title_catalog_query,
    looks_like_book_title_request,
    try_title_catalog_short_circuit,
)
from app.agent_runtime.workflow_isolation import product_handling_allowed
from app.email.speller import build_email_readback_parts
from app.runtime.voice_commerce_runtime import VoiceCommerceRuntime
from app.state.models import SessionState


def test_readback_micro_chunks_for_long_local():
    parts = build_email_readback_parts("bashisultan766@gmail.com")
    assert len(parts) >= 6
    assert parts[0].startswith("Just to confirm")
    assert any("name part" in p.lower() for p in parts)
    assert parts[-1] == "Is that correct?"
    # No single chunk should hold the entire local part spelled out.
    assert all(len(p) < 80 for p in parts)


def test_short_title_requires_explicit_preamble():
    assert looks_like_book_title_request("Gurdwara") is False
    assert looks_like_book_title_request("Red River Vengeance") is False
    assert looks_like_book_title_request("Do you have Game of Thrones") is True
    assert looks_like_book_title_request("Yes.") is False


def test_extract_title_query_strips_preamble():
    assert extract_title_catalog_query("Do you have Red River Vengeance") == "Red River Vengeance"
    assert extract_title_catalog_query("The book title is Gurdwara") == "Gurdwara"


def test_product_handling_requires_explicit_title():
    session = SessionState(
        session_id="s",
        call_sid="CA_TITLE",
        from_number="+1",
        to_number="+2",
    )
    assert not product_handling_allowed(session, "", "Red River Vengeance")
    assert product_handling_allowed(
        session, "", "Do you have Red River Vengeance",
    )


@pytest.mark.asyncio
async def test_title_catalog_search_idle():
    session = SessionState(
        session_id="s",
        call_sid="CA_TITLE",
        from_number="+1",
        to_number="+2",
    )
    payload = {
        "results": [{
            "title": "Red River Vengeance",
            "variant_id": "gid://shopify/ProductVariant/99",
            "price": "14.99",
            "available": True,
            "inventory_quantity": 5,
        }],
        "count": 1,
    }

    with patch(
        "app.agent_runtime.llm_tools._catalog_search",
        new_callable=AsyncMock,
        return_value=json.dumps(payload),
    ):
        result = await try_title_catalog_short_circuit(
            session, "Do you have Red River Vengeance",
        )

    assert result is not None
    assert result.force_reply
    assert "Red River" in result.force_reply
    assert "How many copies" in result.force_reply


@pytest.mark.asyncio
async def test_title_catalog_similar_offer():
    session = SessionState(
        session_id="s",
        call_sid="CA_SIM",
        from_number="+1",
        to_number="+2",
    )
    payload = {
        "results": [{
            "title": "A Different Kind of School",
            "variant_id": "gid://shopify/ProductVariant/88",
            "price": "11.50",
            "available": True,
            "inventory_quantity": 3,
        }],
        "count": 1,
    }

    with patch(
        "app.agent_runtime.llm_tools._catalog_search",
        new_callable=AsyncMock,
        return_value=json.dumps(payload),
    ):
        result = await try_title_catalog_short_circuit(
            session, "I'm looking for Gurdwara",
        )

    assert result is not None
    assert "couldn't find the exact product" in result.force_reply.lower()
    assert "different kind of school" in result.force_reply.lower()
    assert "name and email" not in result.force_reply.lower()


@pytest.mark.asyncio
async def test_email_readback_uses_play_immediately():
    runtime = VoiceCommerceRuntime(settings=type("S", (), {"OPENAI_API_KEY": "k"})())
    session = SessionState(
        session_id="s",
        call_sid="CA_TTS",
        from_number="+1",
        to_number="+2",
        pending_payment_email="bashi64@gmail.com",
        awaiting_payment_email_confirmation=True,
    )
    sent: list[dict] = []

    async def capture(msg: dict):
        sent.append(msg)

    await runtime._speak_email_readback_text(
        session,
        "bashi 6 4 at gmail dot com",
        "placeholder",
        capture,
    )

    assert len(sent) >= 4
    assert all(m.get("play_immediately") for m in sent)
    assert all(m.get("interruptible") is False for m in sent)
    assert all(m.get("last") is True for m in sent)
