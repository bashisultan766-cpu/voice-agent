"""CA3fe7 live regression — OOS ISBN support handoff completes after email confirm."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.agent_runtime.commerce_flow_state import (
    STATUS_AWAITING_ANOTHER_BOOK,
    process_commerce_turn,
)
from app.agent_runtime.isbn_short_circuit import try_isbn_short_circuit
from app.agent_runtime.not_found_escalation_flow import (
    begin_unavailable_product_handoff,
    process_not_found_escalation_turn,
)
from app.escalation.product_not_found_escalation import _STORE
from app.state.models import SessionState

OOS_ISBN = "9781503933392"


def _session(**kwargs) -> SessionState:
    base = dict(
        session_id="sess_ca3fe7",
        call_sid="CA3FE7",
        from_number="+923100000001",
        to_number="+15559994001",
        caller_name="Profile Name From Twilio",
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


def _settings():
    from app.config import Settings

    return Settings(
        SUPPORT_EMAIL="jessica@sureshotbooks.com",
        RESEND_API_KEY="re_test",
        SUPPORT_ESCALATION_FROM_EMAIL="Voice Agent <noreply@sureshotbooks.com>",
        SUPPORT_ESCALATION_ENABLED=True,
    )


def _mock_resend():
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=mock_resp)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    return mock_client


@pytest.mark.asyncio
async def test_oos_isbn_handoff_sends_after_thats_correct_email():
    session = _session()
    oos_payload = {
        "found": True,
        "isbn": OOS_ISBN,
        "product": {
            "product_id": "gid://shopify/Product/2",
            "variant_id": "gid://shopify/ProductVariant/2",
            "title": "Out Of Stock Title",
            "price": "9.99",
            "available": False,
            "inventory_quantity": 0,
        },
    }
    with patch(
        "app.tools.shopify_tools.search_product_by_isbn",
        new_callable=AsyncMock,
        return_value=json.dumps(oos_payload),
    ):
        sc = await try_isbn_short_circuit(session, OOS_ISBN, turn_mode="isbn")

    assert sc and "name and email" in sc.force_reply.lower()
    assert session.awaiting_not_found_escalation_email is True

    mock_client = _mock_resend()
    with patch("app.escalation.support_handoff.get_settings", return_value=_settings()):
        with patch(
            "app.escalation.support_handoff.httpx.AsyncClient",
            return_value=mock_client,
        ):
            with patch(
                "app.escalation.conversation_summarizer.summarize_conversation_for_support",
                new_callable=AsyncMock,
                return_value=("Customer needs OOS book sourced.", ""),
            ):
                name_hint = await process_not_found_escalation_turn(
                    session, "Yes. My name is Bashi Sultan.",
                )
                assert "email" in name_hint.force_reply.lower()

                email_hint = await process_not_found_escalation_turn(
                    session,
                    "bashisultan766 at gmail dot com",
                )
                assert "letter by letter" in email_hint.force_reply

                send_hint = await process_not_found_escalation_turn(
                    session, "Yeah. That's correct email.",
                )

    assert send_hint.extra_tool_result and send_hint.extra_tool_result.success
    assert session.awaiting_not_found_escalation_email is False
    assert mock_client.post.await_count == 1
    body = mock_client.post.call_args.kwargs["json"]["text"]
    assert "Bashi Sultan" in body
    assert "bashisultan766@gmail.com" in body
    assert "Profile Name From Twilio" not in body


def test_another_book_isbn_announcement_keeps_commerce_flow():
    session = _session(commerce_flow_status=STATUS_AWAITING_ANOTHER_BOOK)
    hint = process_commerce_turn(
        session,
        "Yes. I need to add another book. I will give you the ISBN number.",
    )
    assert hint.force_reply
    assert "ISBN" in hint.force_reply


def test_hold_for_another_book_ack():
    session = _session(commerce_flow_status=STATUS_AWAITING_ANOTHER_BOOK)
    hint = process_commerce_turn(session, "So just hold a second for another book.")
    assert hint.force_reply
    assert "ISBN" in hint.force_reply or "ready" in hint.force_reply.lower()
