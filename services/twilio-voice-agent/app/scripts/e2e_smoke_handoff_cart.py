"""One-shot E2E smoke: multi-book commerce, OOS support send, payment email lines."""
from __future__ import annotations

import asyncio
import json
import sys
from unittest.mock import AsyncMock, MagicMock, patch

from app.agent_runtime.commerce_flow_state import STATUS_AWAITING_ANOTHER_BOOK, process_commerce_turn
from app.agent_runtime.isbn_short_circuit import try_isbn_short_circuit
from app.agent_runtime.not_found_escalation_flow import process_not_found_escalation_turn
from app.config import Settings
from app.email.deliverability import build_payment_email_bodies
from app.escalation.product_not_found_escalation import _STORE
from app.state.models import SessionState


async def _run() -> None:
    session = SessionState(
        session_id="e2e_smoke",
        call_sid="CA_E2E",
        from_number="+15550001111",
        to_number="+15559994001",
        caller_name="Twilio Profile Should Not Appear",
    )

    session.commerce_flow_status = STATUS_AWAITING_ANOTHER_BOOK
    hint = process_commerce_turn(
        session,
        "Yes. I need to add another book. I will give you the ISBN number.",
    )
    assert hint.force_reply and "ISBN" in hint.force_reply, hint.force_reply

    _STORE.clear()
    oos_payload = {
        "found": True,
        "isbn": "9781503933392",
        "product": {
            "product_id": "gid://shopify/Product/1",
            "variant_id": "gid://shopify/ProductVariant/1",
            "title": "OOS Book",
            "price": "10.00",
            "available": False,
            "inventory_quantity": 0,
        },
    }
    with patch(
        "app.tools.shopify_tools.search_product_by_isbn",
        new_callable=AsyncMock,
        return_value=json.dumps(oos_payload),
    ):
        sc = await try_isbn_short_circuit(session, "9781503933392", turn_mode="isbn")
    assert sc and "name and email" in sc.force_reply.lower()

    mock_resp = MagicMock(status_code=200)
    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=mock_resp)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    settings = Settings(
        SUPPORT_EMAIL="support@test.com",
        RESEND_API_KEY="re_test",
        SUPPORT_ESCALATION_ENABLED=True,
    )

    with patch("app.escalation.support_handoff.get_settings", return_value=settings):
        with patch("app.escalation.support_handoff.httpx.AsyncClient", return_value=mock_client):
            with patch(
                "app.escalation.conversation_summarizer.summarize_conversation_for_support",
                new_callable=AsyncMock,
                return_value=("Customer needs out-of-stock book sourced.", ""),
            ):
                await process_not_found_escalation_turn(session, "My name is Bashi Sultan.")
                await process_not_found_escalation_turn(
                    session, "bashisultan766 at gmail dot com",
                )
                final = await process_not_found_escalation_turn(
                    session, "Yeah. That's correct email.",
                )

    assert final.extra_tool_result and final.extra_tool_result.success
    assert mock_client.post.await_count == 1
    body = mock_client.post.call_args.kwargs["json"]["text"]
    assert "Bashi Sultan" in body
    assert "bashisultan766@gmail.com" in body
    assert "Twilio Profile Should Not Appear" not in body

    _subject, plain, _html = build_payment_email_bodies(
        "https://pay.example/checkout",
        order_lines=[
            {"title": "Book A", "quantity": 10, "price": "12.99"},
            {"title": "Book B", "quantity": 2, "price": "8.00"},
        ],
    )
    assert "10 cop" in plain and "Book A" in plain
    assert "shipping" in plain.lower()

    print("E2E_SMOKE_OK")


def main() -> int:
    try:
        asyncio.run(_run())
    except Exception as exc:
        print(f"E2E_SMOKE_FAILED: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
